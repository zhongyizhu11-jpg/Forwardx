import assert from "node:assert/strict";
import test from "node:test";

import { decodeBase64Utf8 } from "./proxyNode";
import { PROXY_SUBSCRIPTION_FORMATS } from "./proxySubscription";
import {
  buildProxySubscriptionUrl,
  proxyClientTargetsForFormat,
  proxySubscriptionKindSupported,
  PROXY_CLIENT_TARGETS,
  PROXY_SUBSCRIPTION_KINDS,
} from "./proxyClientImport";

const ORIGIN = "https://panel.example.com";
const TOKEN = "tok123";

test("节点订阅不带 rules 参数，规则订阅带上", () => {
  const nodes = buildProxySubscriptionUrl({ origin: ORIGIN, token: TOKEN, format: "clash", kind: "nodes" });
  const rules = buildProxySubscriptionUrl({ origin: ORIGIN, token: TOKEN, format: "clash", kind: "rules" });

  assert.equal(nodes, "https://panel.example.com/api/sub/tok123?format=clash");
  assert.equal(rules, "https://panel.example.com/api/sub/tok123?format=clash&rules=1");
});

test("通用 base64 不带 format，方便粘进只认裸地址的老客户端", () => {
  const url = buildProxySubscriptionUrl({ origin: ORIGIN, token: TOKEN, format: "base64", kind: "nodes" });

  assert.equal(url, "https://panel.example.com/api/sub/tok123");
});

test("origin 末尾多余的斜杠不会拼出双斜杠", () => {
  const url = buildProxySubscriptionUrl({
    origin: "https://panel.example.com/",
    token: TOKEN,
    format: "loon",
    kind: "nodes",
  });

  assert.equal(url, "https://panel.example.com/api/sub/tok123?format=loon");
});

test("只有能表达规则的格式才提供规则订阅", () => {
  assert.equal(proxySubscriptionKindSupported("clash", "rules"), true);
  assert.equal(proxySubscriptionKindSupported("singbox", "rules"), true);
  // Loon、Surge、QX 的订阅是节点列表，规则要写在用户自己的配置里。
  assert.equal(proxySubscriptionKindSupported("loon", "rules"), false);
  assert.equal(proxySubscriptionKindSupported("surge", "rules"), false);
  assert.equal(proxySubscriptionKindSupported("quantumultx", "rules"), false);
  assert.equal(proxySubscriptionKindSupported("base64", "rules"), false);

  // 节点订阅所有格式都有。
  for (const format of PROXY_SUBSCRIPTION_FORMATS) {
    assert.equal(proxySubscriptionKindSupported(format, "nodes"), true, format);
  }
});

test("订阅地址整体编码后才嵌进导入链接", () => {
  // 地址里带 &，不编码会被外层当成参数分隔符而截断，导入到一半的地址必然失败。
  const url = "https://panel.example.com/api/sub/tok123?format=clash&rules=1";
  const clash = PROXY_CLIENT_TARGETS.find((target) => target.id === "clash")!;

  const link = clash.buildImportUrl(url, "我的手机");

  assert.ok(!link.includes("&rules=1"), `订阅地址未编码: ${link}`);
  assert.ok(link.includes(encodeURIComponent(url)), link);
  assert.match(link, /^clash:\/\/install-config\?url=/);
});

test("各客户端的 scheme 与官方文档一致", () => {
  const url = "https://panel.example.com/api/sub/tok123?format=clash";
  const name = "我的手机";
  const link = (id: string) => PROXY_CLIENT_TARGETS.find((target) => target.id === id)!.buildImportUrl(url, name);

  assert.match(link("clash"), /^clash:\/\/install-config\?url=.+&name=/);
  assert.match(link("stash"), /^stash:\/\/install-config\?url=.+&name=/);
  // sing-box 的名称走 fragment，不是查询参数。
  assert.match(link("singbox"), /^sing-box:\/\/import-remote-profile\?url=[^#]+#/);
  assert.match(link("loon"), /^loon:\/\/import\?sub=.+&name=/);
  // surge 后面是三条斜杠。
  assert.match(link("surge"), /^surge:\/\/\/install-config\?url=/);
  assert.match(link("quantumultx"), /^quantumult-x:\/\/\/add-resource\?remote-resource=/);
  assert.match(link("shadowrocket"), /^sub:\/\//);
});

test("Quantumult X 的参数是编码后的 JSON，带 tag", () => {
  const url = "https://panel.example.com/api/sub/tok123?format=quantumultx";
  const target = PROXY_CLIENT_TARGETS.find((item) => item.id === "quantumultx")!;

  const link = target.buildImportUrl(url, "我的手机");
  const payload = JSON.parse(decodeURIComponent(link.split("remote-resource=")[1]));

  assert.deepEqual(payload, { server_remote: [`${url}, tag=我的手机`] });
});

test("Shadowrocket 的 sub:// 用 base64 而不是查询参数", () => {
  const url = "https://panel.example.com/api/sub/tok123";
  const target = PROXY_CLIENT_TARGETS.find((item) => item.id === "shadowrocket")!;

  const link = target.buildImportUrl(url, "我的手机");
  const encoded = link.slice("sub://".length).split("#")[0];

  // base64url：不能含 + / =，否则在 URL 里会被再次转义。
  assert.doesNotMatch(encoded, /[+/=]/);
  assert.equal(decodeBase64Utf8(encoded), url);
});

test("每个客户端都对应一个真实存在的订阅格式", () => {
  const formats = new Set<string>(PROXY_SUBSCRIPTION_FORMATS);
  for (const target of PROXY_CLIENT_TARGETS) {
    assert.ok(formats.has(target.format), `${target.id} 指向了未知格式 ${target.format}`);
    assert.ok(target.label, `${target.id} 缺少显示名`);
  }

  const ids = PROXY_CLIENT_TARGETS.map((target) => target.id);
  assert.equal(new Set(ids).size, ids.length, "客户端 id 重复");
});

test("每种订阅格式都至少有一个可一键导入的客户端", () => {
  for (const format of PROXY_SUBSCRIPTION_FORMATS) {
    const targets = proxyClientTargetsForFormat(format);
    assert.ok(targets.length > 0, `${format} 没有对应的客户端，界面上会只剩复制按钮`);
  }
});

test("导入链接里的中文名称被编码，不会破坏 scheme", () => {
  const url = "https://panel.example.com/api/sub/tok123";
  for (const target of PROXY_CLIENT_TARGETS) {
    const link = target.buildImportUrl(url, "我的 手机 & 平板");
    // 未编码的空格和 & 会让部分客户端在解析时截断。
    assert.doesNotMatch(link, / /, `${target.id} 的链接含未编码空格: ${link}`);
  }
});

test("两种订阅种类的常量与标签齐全", () => {
  assert.deepEqual([...PROXY_SUBSCRIPTION_KINDS], ["nodes", "rules"]);
});
