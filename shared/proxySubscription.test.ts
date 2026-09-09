import assert from "node:assert/strict";
import test from "node:test";

import { parseProxyNodeLink, relayProxyNode, decodeBase64Utf8, type ProxyNode } from "./proxyNode";
import {
  formatProxySubscriptionUserInfo,
  normalizeProxySubscriptionFormat,
  renderProxySubscription,
  PROXY_SUBSCRIPTION_GROUP_NAME,
} from "./proxySubscription";

function node(link: string, entry: { address: string; port: number; name: string }): ProxyNode {
  const parsed = parseProxyNodeLink(link);
  if (!parsed.ok) throw new Error(parsed.error);
  return relayProxyNode(parsed.node, entry);
}

const VLESS_WS = "vless://abc-uuid@hkt.example.com:443?security=tls&sni=hkt.example.com&type=ws&path=%2Fray&host=cdn.example.com&fp=chrome#HKT";
const TROJAN = "trojan://secret-pass@hk.example.com:443?sni=hk.example.com#TJ";
const SS = "ss://YWVzLTEyOC1nY206c3MtcGFzc3dvcmQ@hk.example.com:8388#SS";

/**
 * 仓库里没有 YAML 依赖，为了真正验证缩进而不是只对字符串，这里实现一个只认
 * 渲染器实际会输出的那个 YAML 子集的解析器。遇到任何预期外的写法直接抛错，
 * 避免它宽松到把错误的 YAML 也解析通过。
 */
function parseYamlSubset(text: string): Record<string, unknown> {
  type Frame = { indent: number; container: unknown };
  const root: Record<string, unknown> = {};
  const stack: Frame[] = [{ indent: -1, container: root }];

  const scalar = (raw: string): unknown => {
    const value = raw.trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      return inner ? inner.split(",").map((item) => scalar(item)) : [];
    }
    if (value === "true") return true;
    if (value === "false") return false;
    if (/^-?\d+$/.test(value)) return Number(value);
    return value;
  };

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    let body = line.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].container;

    let listItem = false;
    if (body.startsWith("- ")) {
      listItem = true;
      body = body.slice(2).trim();
    }

    if (listItem && !Array.isArray(parent)) throw new Error(`列表项的父级不是数组: ${line}`);
    if (!listItem && Array.isArray(parent)) throw new Error(`数组里出现了非列表项: ${line}`);

    const separator = body.indexOf(": ");
    const isBlockKey = body.endsWith(":") && separator < 0;
    if (separator < 0 && !isBlockKey) {
      // 纯标量列表项，例如 rules 下的 MATCH 行。
      (parent as unknown[]).push(scalar(body));
      continue;
    }

    const key = isBlockKey ? body.slice(0, -1).trim() : body.slice(0, separator).trim();
    const rawValue = isBlockKey ? "" : body.slice(separator + 2).trim();

    let target: Record<string, unknown>;
    if (listItem) {
      target = {};
      (parent as unknown[]).push(target);
      // 同一列表项后续的键缩进更深，挂到这个新对象上。
      stack.push({ indent, container: target });
    } else {
      target = parent as Record<string, unknown>;
    }

    if (isBlockKey) {
      // 空值键后面跟的是子块，子块首行是列表项就建数组，否则建对象。
      const child: unknown = key === "proxies" || key === "proxy-groups" || key === "rules" ? [] : {};
      target[key] = child;
      stack.push({ indent: listItem ? indent + 2 : indent, container: child });
    } else {
      target[key] = scalar(rawValue);
    }
  }

  return root;
}

test("Clash output is structurally valid YAML with the right per-protocol field names", () => {
  const nodes = [
    node(VLESS_WS, { address: "1.2.3.4", port: 20001, name: "广州1 → HKT" }),
    node(TROJAN, { address: "5.6.7.8", port: 20002, name: "广州2 → HK" }),
    node(SS, { address: "5.6.7.8", port: 20003, name: "广州2 → SS" }),
  ];

  const parsed = parseYamlSubset(renderProxySubscription(nodes, "clash"));
  const proxies = parsed.proxies as Record<string, unknown>[];

  assert.equal(proxies.length, 3);

  const vless = proxies[0];
  assert.equal(vless.name, "广州1 → HKT");
  assert.equal(vless.type, "vless");
  assert.equal(vless.server, "1.2.3.4");
  assert.equal(vless.port, 20001);
  assert.equal(vless.uuid, "abc-uuid");
  assert.equal(vless.tls, true);
  // vless/vmess 用 servername，用错成 sni 会让 Clash 忽略 SNI。
  assert.equal(vless.servername, "hkt.example.com");
  assert.equal(vless.sni, undefined);
  assert.equal(vless.network, "ws");
  assert.deepEqual(vless["ws-opts"], { path: "/ray", headers: { Host: "cdn.example.com" } });

  const trojan = proxies[1];
  assert.equal(trojan.type, "trojan");
  assert.equal(trojan.password, "secret-pass");
  // trojan 反过来只认 sni。
  assert.equal(trojan.sni, "hk.example.com");
  assert.equal(trojan.servername, undefined);

  const ss = proxies[2];
  assert.equal(ss.type, "ss");
  assert.equal(ss.cipher, "aes-128-gcm");
  assert.equal(ss.password, "ss-password");

  const groups = parsed["proxy-groups"] as Record<string, unknown>[];
  assert.equal(groups[0].name, PROXY_SUBSCRIPTION_GROUP_NAME);
  assert.deepEqual(groups[0].proxies, ["广州1 → HKT", "广州2 → HK", "广州2 → SS"]);
  assert.deepEqual(parsed.rules, [`MATCH,${PROXY_SUBSCRIPTION_GROUP_NAME}`]);
});

test("the mini YAML parser rejects broken indentation", () => {
  // 守住上面那个测试的价值：解析器必须严格到能发现缩进错误。
  assert.throws(() => parseYamlSubset("proxies:\n  - name: \"a\"\n- type: vless\n"));
});

test("sing-box output is valid JSON with a selector over every node", () => {
  const nodes = [
    node(VLESS_WS, { address: "1.2.3.4", port: 20001, name: "广州1 → HKT" }),
    node(SS, { address: "5.6.7.8", port: 20003, name: "广州2 → SS" }),
  ];

  const parsed = JSON.parse(renderProxySubscription(nodes, "singbox"));
  const outbounds = parsed.outbounds as Record<string, any>[];

  assert.equal(outbounds[0].type, "selector");
  assert.deepEqual(outbounds[0].outbounds, ["广州1 → HKT", "广州2 → SS"]);

  const vless = outbounds[1];
  assert.equal(vless.type, "vless");
  assert.equal(vless.server, "1.2.3.4");
  assert.equal(vless.server_port, 20001);
  assert.equal(vless.tls.enabled, true);
  assert.equal(vless.tls.server_name, "hkt.example.com");
  assert.deepEqual(vless.tls.utls, { enabled: true, fingerprint: "chrome" });
  assert.deepEqual(vless.transport, { type: "ws", path: "/ray", headers: { Host: "cdn.example.com" } });

  assert.equal(outbounds[2].type, "shadowsocks");
  assert.equal(outbounds[2].method, "aes-128-gcm");
  assert.equal(outbounds[outbounds.length - 1].type, "direct");
});

test("Loon lines follow the official example config layout", () => {
  const nodes = [
    node(VLESS_WS, { address: "1.2.3.4", port: 20001, name: "广州1 → HKT" }),
    node(TROJAN, { address: "5.6.7.8", port: 20002, name: "广州2 → HK" }),
    node(SS, { address: "5.6.7.8", port: 20003, name: "广州2 → SS" }),
  ];

  const lines = renderProxySubscription(nodes, "loon").trim().split("\n");
  assert.equal(lines.length, 3);

  const [vless, trojan, ss] = lines;
  assert.match(vless, /^广州1 → HKT = VLESS,1\.2\.3\.4,20001,"abc-uuid",/);
  // 官方示例配置用 tls-name，不是 sni。
  assert.match(vless, /tls-name=hkt\.example\.com/);
  assert.doesNotMatch(vless, /(^|,)sni=/);
  assert.match(vless, /transport=ws/);
  assert.match(vless, /path=\/ray/);
  assert.match(vless, /over-tls=true/);

  assert.match(trojan, /^广州2 → HK = trojan,5\.6\.7\.8,20002,"secret-pass",/);
  assert.match(ss, /^广州2 → SS = Shadowsocks,5\.6\.7\.8,20003,aes-128-gcm,"ss-password",/);
});

test("Loon node names drop the characters that would split the line", () => {
  const nodes = [node(VLESS_WS, { address: "1.2.3.4", port: 20001, name: "广州1, 500M = 主力" })];

  const line = renderProxySubscription(nodes, "loon").trim();
  const name = line.slice(0, line.indexOf(" = "));

  assert.doesNotMatch(name, /[,=]/);
  assert.equal(name, "广州1 500M 主力");
});

test("base64 output decodes back to one link per node", () => {
  const nodes = [
    node(VLESS_WS, { address: "1.2.3.4", port: 20001, name: "广州1 → HKT" }),
    node(TROJAN, { address: "5.6.7.8", port: 20002, name: "广州2 → HK" }),
  ];

  const links = decodeBase64Utf8(renderProxySubscription(nodes, "base64")).split("\n");

  assert.equal(links.length, 2);
  assert.match(links[0], /^vless:\/\/abc-uuid@1\.2\.3\.4:20001\?/);
  assert.match(links[0], /#%E5%B9%BF%E5%B7%9E1/);
  assert.match(links[1], /^trojan:\/\/secret-pass@5\.6\.7\.8:20002\?/);
});

test("every format renders an empty node list without crashing", () => {
  for (const format of ["base64", "clash", "singbox", "loon"] as const) {
    const output = renderProxySubscription([], format);
    assert.equal(typeof output, "string");
  }
  // 空列表的 Clash 输出仍要是合法 YAML，否则客户端会报解析错误而不是"无节点"。
  const parsed = parseYamlSubset(renderProxySubscription([], "clash"));
  assert.deepEqual(parsed.proxies, []);
});

test("format aliases from client query strings resolve correctly", () => {
  assert.equal(normalizeProxySubscriptionFormat("clash"), "clash");
  assert.equal(normalizeProxySubscriptionFormat("mihomo"), "clash");
  assert.equal(normalizeProxySubscriptionFormat("sing-box"), "singbox");
  assert.equal(normalizeProxySubscriptionFormat("Loon"), "loon");
  assert.equal(normalizeProxySubscriptionFormat(""), "base64");
  assert.equal(normalizeProxySubscriptionFormat("unknown"), "base64");
});

test("Subscription-Userinfo clamps missing and negative values", () => {
  assert.equal(
    formatProxySubscriptionUserInfo({ upload: 100, download: 200, total: 1000, expire: 1700000000 }),
    "upload=100; download=200; total=1000; expire=1700000000",
  );
  assert.equal(
    formatProxySubscriptionUserInfo({ upload: -5, download: Number.NaN, total: 0, expire: 0 }),
    "upload=0; download=0; total=0; expire=0",
  );
});
