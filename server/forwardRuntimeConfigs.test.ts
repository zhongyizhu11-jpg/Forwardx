import assert from "node:assert/strict";
import test from "node:test";

import {
  REALM_CONFIG_DIR,
  buildRealmConfigToml,
  buildRealmServiceUnit,
  realmConfigPathForPort,
  realmServiceNameForPort,
  realmTomlString,
} from "./forwardRuntimeConfigs";

/**
 * realm 的配置文件与服务单元。
 *
 * 这一层的错都是**不报错的错**：`use_udp` 写反、proxy protocol 版本填错、监听
 * 地址少个方括号 —— realm 要么起不来、要么起来了但流量走不通，而面板上只会看到
 * 一句「等待 Agent 上报」。原来这段拼接埋在六千行路由里，只能靠肉眼看。
 */

const base = {
  sourcePort: 20001,
  remote: "198.51.100.7:443",
  sendProxy: false,
  acceptProxy: false,
  proxyVersion: 1,
};

test("use_udp 跟着规则协议走，不是写死的", () => {
  assert.match(buildRealmConfigToml({ ...base, protocol: "tcp" }), /use_udp = false/);
  assert.match(buildRealmConfigToml({ ...base, protocol: "udp" }), /use_udp = true/);
  assert.match(
    buildRealmConfigToml({ ...base, protocol: "both" }),
    /use_udp = true/,
    "TCP+UDP 的规则要开 UDP，否则 UDP 那一半静默不通",
  );
});

test("PROXY protocol 的收发和版本各自独立", () => {
  const sendOnly = buildRealmConfigToml({ ...base, protocol: "tcp", sendProxy: true, proxyVersion: 2 });
  assert.match(sendOnly, /send_proxy = true/);
  assert.match(sendOnly, /send_proxy_version = 2/);
  assert.match(sendOnly, /accept_proxy = false/, "只开发送时不能顺手把接收也打开");

  const acceptOnly = buildRealmConfigToml({ ...base, protocol: "tcp", acceptProxy: true });
  assert.match(acceptOnly, /accept_proxy = true/);
  assert.match(acceptOnly, /send_proxy = false/, "只开接收时不能顺手把发送也打开");
});

test("监听地址是带方括号的 IPv6 通配，远端原样带进去", () => {
  const config = buildRealmConfigToml({ ...base, protocol: "tcp", remote: "[2001:db8::1]:443" });
  assert.match(config, /listen = "\[::0\]:20001"/, "少了方括号 realm 解析不出监听地址");
  assert.match(config, /remote = "\[2001:db8::1\]:443"/, "IPv6 远端的方括号要原样保留");
});

test("服务名和配置路径按协议分开，TCP 和 UDP 不会互相覆盖", () => {
  assert.equal(realmServiceNameForPort(20001, "tcp"), "forwardx-realm-tcp-20001");
  assert.equal(realmServiceNameForPort(20001, "udp"), "forwardx-realm-udp-20001");
  assert.notEqual(
    realmConfigPathForPort(20001, "tcp"),
    realmConfigPathForPort(20001, "udp"),
    "同一个端口的 TCP 和 UDP 配置写到同一个文件，后写的会把前一个顶掉",
  );
  assert.ok(realmConfigPathForPort(20001, "tcp").startsWith(REALM_CONFIG_DIR + "/"));
});

test("TOML 字符串会转义，不会被目标地址里的引号截断", () => {
  assert.equal(realmTomlString('a"b'), '"a\\"b"');
  assert.equal(realmTomlString(null), '""');
});

test("服务单元：绑网卡时才加 --interface", () => {
  const unitInput = { sourcePort: 20001, targetIp: "198.51.100.7", targetPort: 443, configPath: "/etc/forwardx/realm/x.toml" };
  assert.ok(!buildRealmServiceUnit(unitInput).includes("--interface"), "没指定网卡时不该凭空加参数");
  assert.match(buildRealmServiceUnit({ ...unitInput, networkInterface: "eth0" }), /--interface eth0/);
  assert.match(buildRealmServiceUnit(unitInput), /^\[Unit\]/, "单元文件要以 [Unit] 开头");
  assert.match(buildRealmServiceUnit(unitInput), /WantedBy=multi-user\.target/);
});
