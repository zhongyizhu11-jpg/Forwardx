import assert from "node:assert/strict";
import test from "node:test";

import { parseProxyNodeLink } from "./proxyNode";
import { renderProxySubscription } from "./proxySubscription";
import {
  buildSingboxConfig,
  buildSingboxInbound,
  PROXY_INBOUND_SNELL_VERSIONS,
  createEmptyProxyInbound,
  isValidRealityShortId,
  proxyInboundRealityDest,
  proxyInboundSecurities,
  proxyInboundTransports,
  proxyNodeFromInbound,
  validateProxyInbound,
  type ProxyInbound,
} from "./proxyInbound";

function inbound(overrides: Partial<ProxyInbound>): ProxyInbound {
  return { ...createEmptyProxyInbound(), ...overrides };
}

const VLESS_REALITY = inbound({
  protocol: "vless",
  name: "HK 落地",
  port: 443,
  security: "reality",
  uuid: "8f1c-uuid",
  flow: "xtls-rprx-vision",
  serverName: "dl.google.com",
  realityPrivateKey: "PRIV",
  realityPublicKey: "PUB",
  realityShortId: "ab12",
});

// ==================== 组合校验 ====================

test("REALITY 只对 TCP 系协议开放", () => {
  // REALITY 是架在 TCP 的 TLS 之上的，QUIC 那一层没有它的位置。
  assert.deepEqual(proxyInboundSecurities("vless"), ["reality", "tls", "none"]);
  assert.deepEqual(proxyInboundSecurities("trojan"), ["reality", "tls"]);
  assert.deepEqual(proxyInboundSecurities("hysteria2"), ["tls"]);
  assert.deepEqual(proxyInboundSecurities("tuic"), ["tls"]);
  // AnyTLS 的服务端能开 REALITY，但主流客户端都明说不支持，开出来没人连得上。
  assert.deepEqual(proxyInboundSecurities("anytls"), ["tls"]);
  // 这两个压根没有 TLS 层。
  assert.deepEqual(proxyInboundSecurities("shadowsocks"), ["none"]);
  assert.deepEqual(proxyInboundSecurities("snell"), ["none"]);
});

test("不成立的协议与安全层组合会被挡住，并说清为什么", () => {
  const quic = validateProxyInbound(inbound({
    protocol: "hysteria2", port: 8443, security: "reality", password: "pw",
    realityPrivateKey: "PRIV", realityPublicKey: "PUB", serverName: "a.com",
  }));
  assert.match(quic, /REALITY 只能架在 TCP/);

  const ss = validateProxyInbound(inbound({
    protocol: "shadowsocks", port: 8388, security: "tls", method: "aes-256-gcm", password: "pw",
  }));
  assert.match(ss, /没有 TLS 层/);

  const trojan = validateProxyInbound(inbound({
    protocol: "trojan", port: 443, security: "none", password: "pw",
  }));
  assert.match(trojan, /自带 TLS/);
});

test("XHTTP 开不出来，但要说清「能中转」和「能自建」是两回事", () => {
  // sing-box 不实现 XHTTP，硬存下去只会得到一个没有传输块的入站。
  assert.ok(!proxyInboundTransports("vless").includes("xhttp"));
  const reason = validateProxyInbound({ ...VLESS_REALITY, transport: "xhttp" });
  assert.match(reason, /XHTTP 是 Xray 的传输/);
  assert.match(reason, /仍然可以粘进来中转/);
});

test("缺凭据、缺密钥、缺证书路径都当场报错", () => {
  assert.match(validateProxyInbound({ ...VLESS_REALITY, uuid: "" }), /缺少 UUID/);
  assert.match(validateProxyInbound({ ...VLESS_REALITY, realityPrivateKey: "" }), /缺少 REALITY 私钥/);
  assert.match(validateProxyInbound({ ...VLESS_REALITY, serverName: "" }), /握手域名/);
  assert.match(
    validateProxyInbound(inbound({ protocol: "trojan", port: 443, security: "tls", password: "pw" })),
    /证书和私钥的路径/,
  );
  assert.match(
    validateProxyInbound(inbound({ protocol: "snell", port: 8000, security: "none", password: "psk" })),
    /Snell 入站只支持/,
  );
});

test("REALITY 的 short-id 必须是 0 到 8 字节的十六进制", () => {
  assert.equal(isValidRealityShortId(""), true);
  assert.equal(isValidRealityShortId("ab12"), true);
  assert.equal(isValidRealityShortId("0123456789abcdef"), true);
  // 奇数长度不是完整字节
  assert.equal(isValidRealityShortId("abc"), false);
  // 超过 8 字节
  assert.equal(isValidRealityShortId("0123456789abcdef00"), false);
  // 非十六进制
  assert.equal(isValidRealityShortId("zzzz"), false);
  assert.match(validateProxyInbound({ ...VLESS_REALITY, realityShortId: "abc" }), /short-id/);
});

test("完整的配置校验通过", () => {
  assert.equal(validateProxyInbound(VLESS_REALITY), "");
});

// ==================== sing-box 入站生成 ====================

test("VLESS + REALITY 的入站按官方字段名生成", () => {
  const json = buildSingboxInbound(VLESS_REALITY, "in-1");

  assert.equal(json.type, "vless");
  assert.equal(json.listen_port, 443);
  assert.deepEqual(json.users, [{ name: "forwardx", uuid: "8f1c-uuid", flow: "xtls-rprx-vision" }]);
  assert.deepEqual(json.tls, {
    enabled: true,
    server_name: "dl.google.com",
    reality: {
      enabled: true,
      handshake: { server: "dl.google.com", server_port: 443 },
      private_key: "PRIV",
      // short_id 是数组，不是字符串。
      short_id: ["ab12"],
    },
  });
});

test("REALITY 的握手目标不填时按握手域名的 443 推导", () => {
  assert.deepEqual(proxyInboundRealityDest(VLESS_REALITY), { server: "dl.google.com", port: 443 });
  assert.deepEqual(
    proxyInboundRealityDest({ ...VLESS_REALITY, realityDest: "www.microsoft.com:8443" }),
    { server: "www.microsoft.com", port: 8443 },
  );
});

test("Shadowsocks 的 method 与 password 在顶层，不在 users 里", () => {
  const json = buildSingboxInbound(
    inbound({ protocol: "shadowsocks", port: 8388, security: "none", method: "aes-256-gcm", password: "pw" }),
    "ss",
  );
  assert.equal(json.method, "aes-256-gcm");
  assert.equal(json.password, "pw");
  assert.equal(json.users, undefined);
  // 没有 TLS 层，不该凭空多出一个 tls 块。
  assert.equal(json.tls, undefined);
});

test("Snell 入站只收 v5 与 v6，v4 要挡住", () => {
  /**
   * 这个区间是拿 sing-box 1.14.0 的二进制逐个版本试出来的，不是从文档抄的：
   *   入站 v1/v2/v3/v4 → unsupported version
   *   出站 v5          → unsupported version
   * 两边不一样，看着像笔误，所以单独留一条测试钉住。
   *
   * 放行 v4 的后果不是「这一个节点连不上」，而是 sing-box 拒绝加载整份配置 ——
   * 同一台落地机上其他入站跟着一起停。
   */
  assert.deepEqual([...PROXY_INBOUND_SNELL_VERSIONS], [5, 6]);
  for (const version of [1, 2, 3, 4]) {
    const reason = validateProxyInbound(
      inbound({ protocol: "snell", port: 8000, security: "none", password: "psk", snellVersion: version }),
    );
    assert.match(reason, /只支持 v5 和 v6/, `v${version}`);
  }
  for (const version of [5, 6]) {
    assert.equal(
      validateProxyInbound(inbound({ protocol: "snell", port: 8000, security: "none", password: "psk", snellVersion: version })),
      "",
      `v${version}`,
    );
  }
});

test("Snell 的 psk 在顶层，版本决定是 obfs_mode 还是 mode", () => {
  const v5 = buildSingboxInbound(
    inbound({ protocol: "snell", port: 8000, security: "none", password: "psk", snellVersion: 5, obfs: "http" }),
    "s5",
  );
  assert.equal(v5.psk, "psk");
  assert.equal(v5.version, 5);
  assert.equal(v5.obfs_mode, "http");
  assert.equal(v5.mode, undefined);

  const v6 = buildSingboxInbound(
    inbound({ protocol: "snell", port: 8000, security: "none", password: "psk", snellVersion: 6, snellMode: "unshaped" }),
    "s6",
  );
  assert.equal(v6.version, 6);
  assert.equal(v6.mode, "unshaped");
  // v6 换成了流量整形，没有 obfs。
  assert.equal(v6.obfs_mode, undefined);
});

test("Hysteria2 的混淆是对象，TUIC 的用户带 uuid + password", () => {
  const hy2 = buildSingboxInbound(
    inbound({
      protocol: "hysteria2", port: 8443, security: "tls", password: "pw",
      obfs: "salamander", obfsPassword: "ob", upMbps: 100, downMbps: 200,
      serverName: "a.com", certPath: "/c.pem", keyPath: "/k.pem",
    }),
    "hy2",
  );
  assert.deepEqual(hy2.obfs, { type: "salamander", password: "ob" });
  assert.equal(hy2.up_mbps, 100);
  assert.equal(hy2.down_mbps, 200);
  assert.deepEqual(hy2.tls, {
    enabled: true, server_name: "a.com", certificate_path: "/c.pem", key_path: "/k.pem",
  });

  const tuic = buildSingboxInbound(
    inbound({
      protocol: "tuic", port: 443, security: "tls", uuid: "u", password: "pw",
      congestionControl: "bbr", serverName: "a.com", certPath: "/c.pem", keyPath: "/k.pem",
    }),
    "tuic",
  );
  assert.deepEqual(tuic.users, [{ name: "forwardx", uuid: "u", password: "pw" }]);
  assert.equal(tuic.congestion_control, "bbr");
});

test("ws 传输生成 transport 块", () => {
  const json = buildSingboxInbound(
    { ...VLESS_REALITY, transport: "ws", path: "/ray", host: "cdn.example.com" },
    "ws",
  );
  assert.deepEqual(json.transport, { type: "ws", path: "/ray", headers: { Host: "cdn.example.com" } });
});

test("整份配置是合法 JSON，出站固定直连", () => {
  const text = buildSingboxConfig([{ inbound: VLESS_REALITY, tag: "in-1" }]);
  const config = JSON.parse(text);
  assert.equal(config.inbounds.length, 1);
  assert.equal(config.inbounds[0].tag, "in-1");
  // 落地机只管把流量放出去，不做分流。
  assert.deepEqual(config.outbounds, [{ type: "direct", tag: "direct" }]);
});

// ==================== 派生客户端节点 ====================

test("派生的客户端节点拿到公钥，拿不到私钥", () => {
  const node = proxyNodeFromInbound(VLESS_REALITY, { address: "1.2.3.4" });

  assert.equal(node.protocol, "vless");
  assert.equal(node.name, "HK 落地");
  assert.equal(node.address, "1.2.3.4");
  assert.equal(node.port, 443);
  assert.equal(node.uuid, "8f1c-uuid");
  assert.equal(node.flow, "xtls-rprx-vision");
  assert.equal(node.tls, true);
  assert.equal(node.sni, "dl.google.com");
  assert.equal(node.realityPublicKey, "PUB");
  assert.equal(node.realityShortId, "ab12");
  // REALITY 靠 uTLS 伪装浏览器握手，指纹不填客户端行为不一致。
  assert.equal(node.fingerprint, "chrome");
  // 私钥不该出现在任何一个客户端字段里。
  assert.ok(!JSON.stringify(node).includes("PRIV"));
});

test("派生的节点直接喂给订阅渲染器就能用", () => {
  // 这是整条链路的接缝：入站派生出节点，订阅那一套原样接上，不必再改。
  const node = proxyNodeFromInbound(VLESS_REALITY, { address: "1.2.3.4", name: "广州1 → HK" });
  const document = { nodes: [node], groups: [], ruleSets: [], rules: [] };

  const clash = renderProxySubscription(document, "clash");
  assert.match(clash, /type: vless/);
  assert.match(clash, /public-key: "PUB"/);

  const loon = renderProxySubscription(document, "loon");
  assert.match(loon, /public-key="PUB"/);
});

test("派生的节点转成链接后能再解析回来", () => {
  const node = proxyNodeFromInbound(
    inbound({
      protocol: "hysteria2", name: "HY2", port: 8443, security: "tls", password: "pw",
      obfs: "salamander", obfsPassword: "ob", serverName: "a.com", certPath: "/c", keyPath: "/k",
    }),
    { address: "1.2.3.4" },
  );
  assert.equal(node.tls, true);

  const document = { nodes: [node], groups: [], ruleSets: [], rules: [] };
  const base64 = renderProxySubscription(document, "base64");
  const link = Buffer.from(base64, "base64").toString("utf-8").trim();
  const parsed = parseProxyNodeLink(link);

  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.equal(parsed.node.protocol, "hysteria2");
  assert.equal(parsed.node.password, "pw");
  assert.equal(parsed.node.obfs, "salamander");
  assert.equal(parsed.node.sni, "a.com");
});
