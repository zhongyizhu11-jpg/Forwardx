import assert from "node:assert/strict";
import test from "node:test";

import {
  formatProxyNodeLink,
  parseProxyNodeLink,
  relayProxyNode,
  encodeBase64Utf8,
  type ProxyNode,
} from "./proxyNode";

function parseOrThrow(link: string): ProxyNode {
  const result = parseProxyNodeLink(link);
  if (!result.ok) throw new Error(`${link} 解析失败: ${result.error}`);
  return result.node;
}

test("VLESS link keeps every credential and transport option", () => {
  const node = parseOrThrow(
    "vless://abc-uuid@hkt.example.com:443?encryption=none&security=tls&sni=hkt.example.com&type=ws&path=%2Fray&host=cdn.example.com&fp=chrome#HKT%20落地",
  );

  assert.equal(node.protocol, "vless");
  assert.equal(node.address, "hkt.example.com");
  assert.equal(node.port, 443);
  assert.equal(node.uuid, "abc-uuid");
  assert.equal(node.transport, "ws");
  assert.equal(node.path, "/ray");
  assert.equal(node.host, "cdn.example.com");
  assert.equal(node.tls, true);
  assert.equal(node.sni, "hkt.example.com");
  assert.equal(node.fingerprint, "chrome");
  assert.equal(node.name, "HKT 落地");
});

test("relay rewrite swaps only the address and port", () => {
  const node = parseOrThrow(
    "vless://abc-uuid@hkt.example.com:443?security=tls&sni=hkt.example.com&type=ws&path=%2Fray#HKT",
  );
  const relayed = relayProxyNode(node, { address: "1.2.3.4", port: 20001, name: "广州1 → HKT" });

  assert.equal(relayed.address, "1.2.3.4");
  assert.equal(relayed.port, 20001);
  assert.equal(relayed.name, "广州1 → HKT");
  // 凭据与握手参数必须原样保留，否则中转后连不上落地机。
  assert.equal(relayed.uuid, node.uuid);
  assert.equal(relayed.sni, "hkt.example.com");
  assert.equal(relayed.path, "/ray");
  assert.equal(relayed.transport, "ws");
  // 原节点不能被就地改动。
  assert.equal(node.address, "hkt.example.com");
});

test("relay rewrite pins the original address as SNI when the link omitted it", () => {
  // 链接没写 sni 时客户端会拿连接地址当 SNI。中转后连接地址是入口 IP，
  // 直接改写会让握手带着 IP 去找落地机而失败，所以必须先固化原地址。
  const node = parseOrThrow("vless://abc-uuid@hkt.example.com:443?security=tls&type=tcp#HKT");
  assert.equal(node.sni, "");

  const relayed = relayProxyNode(node, { address: "1.2.3.4", port: 20001, name: "广州1" });

  assert.equal(relayed.sni, "hkt.example.com");
});

test("relay rewrite pins the original address as the websocket Host header", () => {
  const node = parseOrThrow("vless://abc-uuid@hkt.example.com:443?security=tls&type=ws&path=%2Fray#HKT");
  assert.equal(node.host, "");

  const relayed = relayProxyNode(node, { address: "1.2.3.4", port: 20001, name: "广州1" });

  assert.equal(relayed.host, "hkt.example.com");
});

test("plain TCP without TLS gains no SNI from the rewrite", () => {
  const node = parseOrThrow("vless://abc-uuid@hkt.example.com:8080?security=none&type=tcp#HKT");
  const relayed = relayProxyNode(node, { address: "1.2.3.4", port: 20001, name: "广州1" });

  assert.equal(relayed.tls, false);
  assert.equal(relayed.sni, "");
});

test("VMess base64 JSON links parse into the shared model", () => {
  const payload = {
    v: "2",
    ps: "香港节点",
    add: "hk.example.com",
    port: "443",
    id: "vmess-uuid",
    aid: "0",
    scy: "auto",
    net: "ws",
    host: "cdn.example.com",
    path: "/vm",
    tls: "tls",
    sni: "hk.example.com",
  };
  const node = parseOrThrow(`vmess://${encodeBase64Utf8(JSON.stringify(payload))}`);

  assert.equal(node.protocol, "vmess");
  assert.equal(node.name, "香港节点");
  assert.equal(node.uuid, "vmess-uuid");
  assert.equal(node.transport, "ws");
  assert.equal(node.path, "/vm");
  assert.equal(node.tls, true);
});

test("Trojan defaults to TLS even when the link omits security", () => {
  const node = parseOrThrow("trojan://secret-pass@hk.example.com:443?sni=hk.example.com#Trojan");

  assert.equal(node.protocol, "trojan");
  assert.equal(node.password, "secret-pass");
  assert.equal(node.tls, true);
});

test("Shadowsocks parses both SIP002 and the legacy fully-encoded form", () => {
  const sip002 = parseOrThrow(
    `ss://${encodeBase64Utf8("aes-128-gcm:ss-password").replace(/=+$/, "")}@hk.example.com:8388#SS`,
  );
  assert.equal(sip002.method, "aes-128-gcm");
  assert.equal(sip002.password, "ss-password");
  assert.equal(sip002.address, "hk.example.com");
  assert.equal(sip002.port, 8388);

  const legacy = parseOrThrow(`ss://${encodeBase64Utf8("aes-256-gcm:legacy-pass@hk.example.com:8389")}#SS旧`);
  assert.equal(legacy.method, "aes-256-gcm");
  assert.equal(legacy.password, "legacy-pass");
  assert.equal(legacy.port, 8389);
});

test("IPv6 entry addresses survive the round trip", () => {
  const node = parseOrThrow("vless://abc-uuid@hkt.example.com:443?security=tls&sni=hkt.example.com#HKT");
  const relayed = relayProxyNode(node, { address: "2001:db8::1", port: 20001, name: "IPv6 入口" });
  const link = formatProxyNodeLink(relayed);

  assert.match(link, /@\[2001:db8::1\]:20001/);
  const reparsed = parseOrThrow(link);
  assert.equal(reparsed.address, "2001:db8::1");
  assert.equal(reparsed.port, 20001);
});

test("每种协议都能 解析 → 中转改写 → 还原 → 再解析 而不丢凭据", () => {
  const links = [
    "vless://abc-uuid@hkt.example.com:443?security=tls&sni=hkt.example.com&type=ws&path=%2Fray&flow=xtls-rprx-vision#VLESS",
    `vmess://${encodeBase64Utf8(JSON.stringify({ v: "2", ps: "VM", add: "hk.example.com", port: "443", id: "vmess-uuid", aid: "0", net: "ws", path: "/vm", tls: "tls", sni: "hk.example.com" }))}`,
    "trojan://secret-pass@hk.example.com:443?sni=hk.example.com&type=tcp#TJ",
    `ss://${encodeBase64Utf8("aes-128-gcm:ss-password").replace(/=+$/, "")}@hk.example.com:8388#SS`,
  ];

  for (const link of links) {
    const original = parseOrThrow(link);
    const relayed = relayProxyNode(original, { address: "1.2.3.4", port: 20001, name: "广州1" });
    const reparsed = parseOrThrow(formatProxyNodeLink(relayed));

    assert.equal(reparsed.protocol, original.protocol, link);
    assert.equal(reparsed.uuid, original.uuid, link);
    assert.equal(reparsed.password, original.password, link);
    assert.equal(reparsed.method || "auto", original.method || "auto", link);
    assert.equal(reparsed.address, "1.2.3.4", link);
    assert.equal(reparsed.port, 20001, link);
    assert.equal(reparsed.transport, original.transport, link);
    assert.equal(reparsed.tls, original.tls, link);
  }
});

test("Reality parameters are preserved through the rewrite", () => {
  const node = parseOrThrow(
    "vless://abc-uuid@hkt.example.com:443?security=reality&sni=www.microsoft.com&pbk=publickey123&sid=ab12&fp=chrome&type=tcp#Reality",
  );
  assert.equal(node.realityPublicKey, "publickey123");
  assert.equal(node.realityShortId, "ab12");

  const link = formatProxyNodeLink(relayProxyNode(node, { address: "1.2.3.4", port: 20001, name: "广州1" }));
  const reparsed = parseOrThrow(link);

  assert.equal(reparsed.realityPublicKey, "publickey123");
  assert.equal(reparsed.realityShortId, "ab12");
  assert.equal(reparsed.sni, "www.microsoft.com");
});

test("unsupported and malformed links report a usable reason", () => {
  const unsupported = parseProxyNodeLink("hysteria2://pass@example.com:443");
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.match(unsupported.error, /暂不支持该协议/);

  const malformed = parseProxyNodeLink("vless://not-a-real-link");
  assert.equal(malformed.ok, false);

  const empty = parseProxyNodeLink("   ");
  assert.equal(empty.ok, false);
});

// ==================== Reality 与 Shadowrocket 写法 ====================

test("Shadowrocket 的 vless 链接：整段 base64，参数名也不同", () => {
  // 标准写法是 vless://uuid@host:port?security=reality&pbk=...
  // Shadowrocket 写成 vless://base64(method:uuid@host:port)?tls=1&peer=...&pbk=...
  // 不认这种的后果是整条链接解析失败，用户只看到「格式无法识别」。
  const link =
    "vless://YXV0bzpiOGRjOGIxMi1iMmY4LTQ0MTAtYjk3NS1kMDgwNWJlYWRkZDNAMTU0LjM2LjE3NC44NTo2MzI4NA" +
    "?remarks=Cst%20hk&tls=1&peer=aws.amazon.com&xtls=2&pbk=PUBKEY123";
  const result = parseProxyNodeLink(link);

  assert.ok(result.ok, result.ok ? "" : result.error);
  const node = result.node;
  assert.equal(node.address, "154.36.174.85");
  assert.equal(node.port, 63284);
  assert.equal(node.uuid, "b8dc8b12-b2f8-4410-b975-d0805beaddd3", "base64 里的 method: 前缀要丢掉");
  assert.equal(node.name, "Cst hk", "名字在 remarks 参数里，不是 # 后面");
  assert.equal(node.tls, true, "tls=1 也算开启 TLS");
  assert.equal(node.sni, "aws.amazon.com", "peer 就是 SNI");
  assert.equal(node.realityPublicKey, "PUBKEY123", "没写 security=reality，靠 pbk 存在判断");
  assert.equal(node.flow, "xtls-rprx-vision", "xtls=2 是数字不是布尔");
});

test("xtls=0 不算启用流控", () => {
  const link = "vless://u@1.2.3.4:443?tls=1&xtls=0";
  const result = parseProxyNodeLink(link);
  assert.ok(result.ok);
  assert.equal(result.node.flow, "");
});

test("显式给了 flow 时以 flow 为准", () => {
  const link = "vless://u@1.2.3.4:443?security=reality&pbk=K&flow=xtls-rprx-vision&xtls=1";
  const result = parseProxyNodeLink(link);
  assert.ok(result.ok);
  assert.equal(result.node.flow, "xtls-rprx-vision");
});

test("标准写法不受影响", () => {
  // 改解析器最容易伤到的就是原本能用的那条路。
  const link =
    "vless://b8dc8b12@1.2.3.4:443?security=reality&sni=a.com&pbk=PK&sid=ab12&fp=chrome&flow=xtls-rprx-vision#名字";
  const result = parseProxyNodeLink(link);

  assert.ok(result.ok);
  assert.equal(result.node.uuid, "b8dc8b12");
  assert.equal(result.node.name, "名字");
  assert.equal(result.node.realityPublicKey, "PK");
  assert.equal(result.node.realityShortId, "ab12");
});
