import assert from "node:assert/strict";
import test from "node:test";

import { parseProxyNodeLink, relayProxyNode, decodeBase64Utf8, encodeBase64Utf8, type ProxyNode } from "./proxyNode";
import { buildProxySubscriptionDocument } from "./proxySubscriptionPlan";
import {
  formatProxySubscriptionUserInfo,
  normalizeProxySubscriptionFormat,
  proxySubscriptionFormatSupportsGroups,
  renderProxySubscription,
  PROXY_SUBSCRIPTION_FORMATS,
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

  const document = buildProxySubscriptionDocument(
    { entries: nodes.map((node, index) => ({ ruleId: index + 1, templateId: index + 1, kind: "relay" as const, frontTemplateId: 0, node })), skipped: [] },
    [],
    { mainGroupName: PROXY_SUBSCRIPTION_GROUP_NAME },
  );
  const parsed = parseYamlSubset(renderProxySubscription(document, "clash"));
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

  const document = buildProxySubscriptionDocument(
    { entries: nodes.map((node, index) => ({ ruleId: index + 1, templateId: index + 1, kind: "relay" as const, frontTemplateId: 0, node })), skipped: [] },
    [],
    { mainGroupName: PROXY_SUBSCRIPTION_GROUP_NAME },
  );
  const parsed = JSON.parse(renderProxySubscription(document, "singbox"));
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

  const lines = renderProxySubscription({ nodes: nodes, groups: [], ruleSets: [], rules: [] }, "loon").trim().split("\n");
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

  const line = renderProxySubscription({ nodes: nodes, groups: [], ruleSets: [], rules: [] }, "loon").trim();
  const name = line.slice(0, line.indexOf(" = "));

  assert.doesNotMatch(name, /[,=]/);
  assert.equal(name, "广州1 500M 主力");
});

test("base64 output decodes back to one link per node", () => {
  const nodes = [
    node(VLESS_WS, { address: "1.2.3.4", port: 20001, name: "广州1 → HKT" }),
    node(TROJAN, { address: "5.6.7.8", port: 20002, name: "广州2 → HK" }),
  ];

  const links = decodeBase64Utf8(renderProxySubscription({ nodes: nodes, groups: [], ruleSets: [], rules: [] }, "base64")).split("\n");

  assert.equal(links.length, 2);
  assert.match(links[0], /^vless:\/\/abc-uuid@1\.2\.3\.4:20001\?/);
  assert.match(links[0], /#%E5%B9%BF%E5%B7%9E1/);
  assert.match(links[1], /^trojan:\/\/secret-pass@5\.6\.7\.8:20002\?/);
});

test("every format renders an empty node list without crashing", () => {
  // 用常量而不是写死列表：新增格式会自动纳入这条冒烟测试。
  for (const format of PROXY_SUBSCRIPTION_FORMATS) {
    const output = renderProxySubscription({ nodes: [], groups: [], ruleSets: [], rules: [] }, format);
    assert.equal(typeof output, "string");
  }
  // 空列表的 Clash 输出仍要是合法 YAML，否则客户端会报解析错误而不是"无节点"。
  const parsed = parseYamlSubset(renderProxySubscription({ nodes: [], groups: [], ruleSets: [], rules: [] }, "clash"));
  assert.deepEqual(parsed.proxies, []);
  assert.deepEqual(parsed["proxy-groups"], []);
  // 没有策略组时 MATCH 不能指向不存在的组，否则 Clash 拒绝整份配置。
  assert.deepEqual(parsed.rules, ["MATCH,DIRECT"]);
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

test("Clash 的自动选路组带测速地址和容差", () => {
  const document = {
    nodes: [
      node(VLESS_WS, { address: "1.2.3.4", port: 20001, name: "广州1 → HKT" }),
      node(VLESS_WS, { address: "5.6.7.8", port: 20002, name: "广州2 → HKT" }),
    ],
    groups: [
      { name: "ForwardX", type: "select" as const, members: ["HKT 自动选路", "广州1 → HKT", "广州2 → HKT"] },
      { name: "HKT 自动选路", type: "url-test" as const, members: ["广州1 → HKT", "广州2 → HKT"] },
    ],
    ruleSets: [],
    rules: [],
  };

  const parsed = parseYamlSubset(renderProxySubscription(document, "clash"));
  const groups = parsed["proxy-groups"] as Record<string, any>[];

  assert.equal(groups[0].type, "select");
  assert.equal(groups[0].url, undefined, "选择器不该带测速地址");

  assert.equal(groups[1].name, "HKT 自动选路");
  assert.equal(groups[1].type, "url-test");
  assert.deepEqual(groups[1].proxies, ["广州1 → HKT", "广州2 → HKT"]);
  assert.equal(groups[1].url, "http://www.gstatic.com/generate_204");
  assert.equal(groups[1].interval, 300);
  // 容差避免两条中转延迟接近时反复横跳，每次切换都会断开已有连接。
  assert.equal(groups[1].tolerance, 50);

  // 流量入口指向主选择器。
  assert.deepEqual(parsed.rules, ["MATCH,ForwardX"]);
});

test("Clash 的主备组不带容差", () => {
  const document = {
    nodes: [node(VLESS_WS, { address: "1.2.3.4", port: 20001, name: "广州1 → HKT" })],
    groups: [
      { name: "ForwardX", type: "select" as const, members: ["HKT 自动选路"] },
      { name: "HKT 自动选路", type: "fallback" as const, members: ["广州1 → HKT"] },
    ],
    ruleSets: [],
    rules: [],
  };

  const parsed = parseYamlSubset(renderProxySubscription(document, "clash"));
  const groups = parsed["proxy-groups"] as Record<string, any>[];

  assert.equal(groups[1].type, "fallback");
  assert.equal(groups[1].url, "http://www.gstatic.com/generate_204");
  // fallback 按顺序取第一个可用，容差没有意义。
  assert.equal(groups[1].tolerance, undefined);
});

test("sing-box 的自动选路组渲染成 urltest", () => {
  const document = {
    nodes: [
      node(VLESS_WS, { address: "1.2.3.4", port: 20001, name: "广州1 → HKT" }),
      node(VLESS_WS, { address: "5.6.7.8", port: 20002, name: "广州2 → HKT" }),
    ],
    groups: [
      { name: "ForwardX", type: "select" as const, members: ["HKT 自动选路"] },
      { name: "HKT 自动选路", type: "url-test" as const, members: ["广州1 → HKT", "广州2 → HKT"] },
    ],
    ruleSets: [],
    rules: [],
  };

  const parsed = JSON.parse(renderProxySubscription(document, "singbox"));
  const outbounds = parsed.outbounds as Record<string, any>[];

  assert.equal(outbounds[0].type, "selector");
  assert.deepEqual(outbounds[0].outbounds, ["HKT 自动选路"]);

  assert.equal(outbounds[1].type, "urltest");
  assert.equal(outbounds[1].tag, "HKT 自动选路");
  assert.deepEqual(outbounds[1].outbounds, ["广州1 → HKT", "广州2 → HKT"]);
  // sing-box 的 interval 是带单位的字符串，写成数字会被拒绝。
  assert.equal(outbounds[1].interval, "300s");

  // 组之后才是真实节点。
  assert.equal(outbounds[2].type, "vless");
});

test("base64 与 Loon 忽略策略组，只输出节点", () => {
  const document = {
    nodes: [node(VLESS_WS, { address: "1.2.3.4", port: 20001, name: "广州1 → HKT" })],
    groups: [
      { name: "ForwardX", type: "select" as const, members: ["HKT 自动选路"] },
      { name: "HKT 自动选路", type: "url-test" as const, members: ["广州1 → HKT"] },
    ],
    ruleSets: [],
    rules: [],
  };

  // base64 是 URI 列表，Loon 的节点订阅只收节点行；塞进策略组会让订阅解析失败。
  const links = decodeBase64Utf8(renderProxySubscription(document, "base64")).split("\n").filter(Boolean);
  assert.equal(links.length, 1);
  assert.doesNotMatch(links[0], /自动选路/);

  const loon = renderProxySubscription(document, "loon").trim().split("\n");
  assert.equal(loon.length, 1);
  assert.doesNotMatch(loon[0], /\[Proxy Group\]/);

  assert.equal(proxySubscriptionFormatSupportsGroups("clash"), true);
  assert.equal(proxySubscriptionFormatSupportsGroups("singbox"), true);
  assert.equal(proxySubscriptionFormatSupportsGroups("base64"), false);
  assert.equal(proxySubscriptionFormatSupportsGroups("loon"), false);
});

// ==================== Surge / Quantumult X ====================

const VMESS_WS = `vmess://${encodeBase64Utf8(JSON.stringify({
  v: "2", ps: "VM", add: "hk.example.com", port: "443", id: "vmess-uuid", aid: "0",
  net: "ws", path: "/vm", host: "cdn.example.com", tls: "tls", sni: "hk.example.com",
}))}`;

test("Surge 跳过 VLESS 并在文件里说明原因", () => {
  const document = {
    nodes: [
      node(VLESS_WS, { address: "1.2.3.4", port: 20001, name: "广州1 → HKT" }),
      node(TROJAN, { address: "5.6.7.8", port: 20002, name: "广州2 → HK" }),
    ],
    groups: [],
    ruleSets: [],
    rules: [],
  };

  const output = renderProxySubscription(document, "surge");
  const lines = output.trim().split("\n");

  // Surge 原生不支持 VLESS，编一行它读不懂的配置比跳过更糟。
  assert.match(lines[0], /^# 已跳过节点.+Surge \/ Surfboard 不支持 VLESS/);
  assert.match(lines[0], /广州1 → HKT/);
  assert.match(lines[1], /^#/);
  assert.equal(lines.length, 3);
  assert.match(lines[2], /^广州2 → HK = trojan, 5\.6\.7\.8, 20002, password=secret-pass/);
});

test("Surge 的 VMess 用 username 和 ws-headers", () => {
  const document = {
    nodes: [node(VMESS_WS, { address: "1.2.3.4", port: 20001, name: "广州1 → VM" })],
    groups: [],
    ruleSets: [],
    rules: [],
  };

  const line = renderProxySubscription(document, "surge").trim();

  assert.match(line, /^广州1 → VM = vmess, 1\.2\.3\.4, 20001, username=vmess-uuid/);
  assert.match(line, /ws=true/);
  assert.match(line, /ws-path=\/vm/);
  // Surge 的 ws-headers 是 `键:值`，不是 JSON。
  assert.match(line, /ws-headers=Host:cdn\.example\.com/);
  assert.match(line, /tls=true/);
  assert.match(line, /sni=hk\.example\.com/);
});

test("Surge 的 trojan 不重复带 tls=true", () => {
  const document = {
    nodes: [node(TROJAN, { address: "5.6.7.8", port: 20002, name: "TJ" })],
    groups: [],
    ruleSets: [],
    rules: [],
  };

  const line = renderProxySubscription(document, "surge").trim();

  // trojan 本身即 TLS，Surge 不接受再带 tls=true。
  assert.doesNotMatch(line, /tls=true/);
  assert.match(line, /sni=hk\.example\.com/);
  assert.match(line, /skip-cert-verify=false/);
});

test("Surge 全是 VLESS 时只剩说明，不产出空文件", () => {
  const document = {
    nodes: [node(VLESS_WS, { address: "1.2.3.4", port: 20001, name: "广州1 → HKT" })],
    groups: [],
    ruleSets: [],
    rules: [],
  };

  const lines = renderProxySubscription(document, "surge").trim().split("\n");

  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.startsWith("#")));
  // 要告诉用户去用哪种格式，否则他只会看到一个空订阅。
  assert.match(lines[1], /Clash 或 sing-box/);
});

test("Quantumult X 支持 VLESS，字段名用它自己那套", () => {
  const document = {
    nodes: [node(VLESS_WS, { address: "1.2.3.4", port: 20001, name: "广州1 → HKT" })],
    groups: [],
    ruleSets: [],
    rules: [],
  };

  const line = renderProxySubscription(document, "quantumultx").trim();

  assert.match(line, /^vless=1\.2\.3\.4:20001/);
  // VLESS 不加密，QX 要求 method 固定 none。
  assert.match(line, /method=none/);
  assert.match(line, /password=abc-uuid/);
  // 传输方式在 QX 里叫 obfs，ws over TLS 是 wss。
  assert.match(line, /obfs=wss/);
  assert.match(line, /obfs-uri=\/ray/);
  assert.match(line, /obfs-host=cdn\.example\.com/);
  assert.match(line, /tls-verification=true/);
  assert.match(line, /tag=广州1 → HKT$/);
});

test("Quantumult X 的 trojan 走 over-tls 而不是 obfs", () => {
  const document = {
    nodes: [node(TROJAN, { address: "5.6.7.8", port: 20002, name: "TJ" })],
    groups: [],
    ruleSets: [],
    rules: [],
  };

  const line = renderProxySubscription(document, "quantumultx").trim();

  assert.match(line, /^trojan=5\.6\.7\.8:20002/);
  assert.match(line, /over-tls=true/);
  assert.match(line, /tls-host=hk\.example\.com/);
  assert.doesNotMatch(line, /obfs=/);
});

test("Quantumult X 的 Shadowsocks 与纯 TCP over TLS", () => {
  const ss = renderProxySubscription(
    { nodes: [node(SS, { address: "5.6.7.8", port: 20003, name: "SS" })], groups: [], ruleSets: [], rules: [] },
    "quantumultx",
  ).trim();
  assert.match(ss, /^shadowsocks=5\.6\.7\.8:20003, method=aes-128-gcm, password=ss-password/);

  const tcpTls = renderProxySubscription(
    {
      nodes: [node("vless://u@hkt.example.com:443?security=tls&sni=hkt.example.com&type=tcp#T", {
        address: "1.2.3.4", port: 20001, name: "TCP",
      })],
      groups: [],
      ruleSets: [],
      rules: [],
    },
    "quantumultx",
  ).trim();
  // 纯 TCP 加 TLS 在 QX 里是 obfs=over-tls，不是 wss。
  assert.match(tcpTls, /obfs=over-tls/);
  assert.match(tcpTls, /obfs-host=hkt\.example\.com/);
});

test("Surge 与 QX 都不输出策略组", () => {
  const document = {
    nodes: [node(TROJAN, { address: "5.6.7.8", port: 20002, name: "TJ" })],
    groups: [
      { name: "ForwardX", type: "select" as const, members: ["TJ"] },
      { name: "自动选路", type: "url-test" as const, members: ["TJ"] },
    ],
    ruleSets: [],
    rules: [],
  };

  // 两者的订阅都是节点列表，策略组要写在用户自己的配置里。
  for (const format of ["surge", "quantumultx"] as const) {
    const output = renderProxySubscription(document, format);
    assert.doesNotMatch(output, /自动选路/, format);
    assert.equal(proxySubscriptionFormatSupportsGroups(format), false);
  }
});

test("新增格式的别名解析", () => {
  assert.equal(normalizeProxySubscriptionFormat("surge"), "surge");
  // Surfboard 用的就是 Surge 的配置格式。
  assert.equal(normalizeProxySubscriptionFormat("surfboard"), "surge");
  assert.equal(normalizeProxySubscriptionFormat("quantumultx"), "quantumultx");
  assert.equal(normalizeProxySubscriptionFormat("qx"), "quantumultx");
  assert.equal(normalizeProxySubscriptionFormat("QuanX"), "quantumultx");
});

test("Loon 的 VLESS Reality 节点必须带公钥", () => {
  // 缺公钥就握不上手，而 Loon 只会显示一句 Failed —— 看不出缺的是参数而不是网络。
  // 写法按 Loon 官方文档的 VLESS Reality 示例：public-key 带引号，short-id 不带。
  const parsed = parseProxyNodeLink(
    "vless://uuid-1@1.2.3.4:443?security=reality&sni=aws.amazon.com&pbk=PUBKEY123&sid=ab12&flow=xtls-rprx-vision#HK",
  );
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);

  const output = renderProxySubscription(
    { nodes: [parsed.node], groups: [], ruleSets: [], rules: [] },
    "loon",
  );

  assert.match(output, /public-key="PUBKEY123"/);
  assert.match(output, /short-id=ab12/);
  assert.match(output, /flow=xtls-rprx-vision/);
  assert.match(output, /over-tls=true/);
});

test("非 Reality 的节点不会凭空多出 public-key", () => {
  const parsed = parseProxyNodeLink("vless://uuid-2@1.2.3.4:443?security=tls&sni=a.com#HK");
  assert.ok(parsed.ok);

  const output = renderProxySubscription(
    { nodes: [parsed.node], groups: [], ruleSets: [], rules: [] },
    "loon",
  );

  assert.doesNotMatch(output, /public-key/);
  assert.doesNotMatch(output, /short-id/);
});

// ==================== Hysteria2 / TUIC / AnyTLS 各家渲染 ====================

const HY2 = "hysteria2://hy2-pass@hk.example.com:8443/?obfs=salamander&obfs-password=ob&sni=hk.example.com&alpn=h3#HY2";
const HY2_GECKO = "hysteria2://hy2-pass@hk.example.com:8443/?obfs=gecko&obfs-password=ob&sni=hk.example.com#HY2G";
const TUIC = "tuic://uuid-1:tuic-pass@hk.example.com:443?congestion_control=bbr&udp_relay_mode=native&sni=hk.example.com#TUIC";
const ANYTLS = "anytls://at-pass@hk.example.com:443/?sni=hk.example.com#AT";

function only(link: string, name: string) {
  return {
    nodes: [node(link, { address: "1.2.3.4", port: 20001, name })],
    groups: [],
    ruleSets: [],
    rules: [],
  };
}

test("Clash 的 Hysteria2 用 password + obfs，而不是 tls: true 那一套", () => {
  const parsed = parseYamlSubset(renderProxySubscription(only(HY2, "广州1 → HY2"), "clash"));
  const proxy = (parsed.proxies as Record<string, unknown>[])[0];

  assert.equal(proxy.type, "hysteria2");
  assert.equal(proxy.password, "hy2-pass");
  assert.equal(proxy.obfs, "salamander");
  assert.equal(proxy["obfs-password"], "ob");
  // Hysteria2 的服务器名在 mihomo 里就叫 sni，不是 servername。
  assert.equal(proxy.sni, "hk.example.com");
  // 这几个键在 hysteria2 条目里不存在，写了就是无效字段。
  assert.equal(proxy.tls, undefined);
  assert.equal(proxy.servername, undefined);
  assert.equal(proxy.network, undefined);
});

test("Clash 的 TUIC 用 congestion-controller 这个连字符键名", () => {
  const parsed = parseYamlSubset(renderProxySubscription(only(TUIC, "广州1 → TUIC"), "clash"));
  const proxy = (parsed.proxies as Record<string, unknown>[])[0];

  assert.equal(proxy.type, "tuic");
  assert.equal(proxy.uuid, "uuid-1");
  assert.equal(proxy.password, "tuic-pass");
  // sing-box 那边叫 congestion_control，抄错了 mihomo 会当成未知字段。
  assert.equal(proxy["congestion-controller"], "bbr");
  assert.equal(proxy["udp-relay-mode"], "native");
});

test("Clash 的 AnyTLS 带 udp，QUIC 系不带", () => {
  const anytls = parseYamlSubset(renderProxySubscription(only(ANYTLS, "AT"), "clash"));
  assert.equal(((anytls.proxies as Record<string, unknown>[])[0]).udp, true);

  const hy2 = parseYamlSubset(renderProxySubscription(only(HY2, "HY2"), "clash"));
  // 官方字段表里 hysteria2 没有 udp 这一项，它本身就跑在 UDP 上。
  assert.equal(((hy2.proxies as Record<string, unknown>[])[0]).udp, undefined);
});

test("sing-box 的 Hysteria2 混淆是对象，TUIC 的 disable_sni 在 tls 里", () => {
  const hy2 = JSON.parse(renderProxySubscription(only(HY2, "HY2"), "singbox"));
  const hy2Out = hy2.outbounds.find((item: any) => item.type === "hysteria2");
  assert.deepEqual(hy2Out.obfs, { type: "salamander", password: "ob" });
  assert.equal(hy2Out.password, "hy2-pass");
  assert.equal(hy2Out.tls.enabled, true);
  assert.equal(hy2Out.tls.server_name, "hk.example.com");

  const tuicLink = `${TUIC.split("#")[0]}&disable_sni=1#TUIC`;
  const tuic = JSON.parse(renderProxySubscription(only(tuicLink, "TUIC"), "singbox"));
  const tuicOut = tuic.outbounds.find((item: any) => item.type === "tuic");
  assert.equal(tuicOut.uuid, "uuid-1");
  assert.equal(tuicOut.congestion_control, "bbr");
  assert.equal(tuicOut.udp_relay_mode, "native");
  // disable_sni 是 TLS 选项，放到出站顶层 sing-box 不认。
  assert.equal(tuicOut.tls.disable_sni, true);
  assert.equal(tuicOut.disable_sni, undefined);
});

test("sing-box 的 AnyTLS 只要 password 和 tls", () => {
  const parsed = JSON.parse(renderProxySubscription(only(ANYTLS, "AT"), "singbox"));
  const out = parsed.outbounds.find((item: any) => item.type === "anytls");
  assert.equal(out.password, "at-pass");
  assert.equal(out.tls.enabled, true);
});

test("Loon 支持 Hysteria2 与 AnyTLS，但没有 TUIC", () => {
  const hy2 = renderProxySubscription(only(HY2, "广州1 → HY2"), "loon").trim();
  assert.match(hy2, /^广州1 → HY2 = Hysteria2,1\.2\.3\.4,20001,"hy2-pass"/);
  assert.match(hy2, /tls-name=hk\.example\.com/);
  assert.match(hy2, /salamander-password=ob/);
  // Loon 的 alpn 要带引号，否则多个值会把逗号分隔的行拆错位。
  assert.match(hy2, /alpn="h3"/);

  const at = renderProxySubscription(only(ANYTLS, "AT"), "loon").trim();
  assert.match(at, /^AT = anytls,1\.2\.3\.4,20001,"at-pass"/);

  const tuic = renderProxySubscription(only(TUIC, "TUIC"), "loon").trim().split("\n");
  assert.ok(tuic.every((line) => line.startsWith("#")));
  assert.match(tuic[0], /Loon 不支持 TUIC/);
});

test("Loon 的 Hysteria2 遇到 gecko 混淆宁可跳过", () => {
  // Loon 只有 salamander-password 一个参数位；照发出去就是「能导入、连不上」。
  const lines = renderProxySubscription(only(HY2_GECKO, "HY2G"), "loon").trim().split("\n");
  assert.ok(lines.every((line) => line.startsWith("#")));
  assert.match(lines[0], /只支持 salamander 混淆/);
});

test("Surge 的三个新协议各用各的策略类型名", () => {
  const hy2 = renderProxySubscription(only(HY2, "HY2"), "surge").trim();
  assert.match(hy2, /^HY2 = hysteria2, 1\.2\.3\.4, 20001, password=hy2-pass/);
  assert.match(hy2, /salamander-password=ob/);
  // 协议自带 TLS，Surge 不接受再写 tls=true；UDP 也是协议自带的。
  assert.doesNotMatch(hy2, /tls=true/);
  assert.doesNotMatch(hy2, /udp-relay=/);
  assert.match(hy2, /sni=hk\.example\.com/);

  const tuic = renderProxySubscription(only(TUIC, "TUIC"), "surge").trim();
  // Surge 把 v4 和 v5 当两种类型，v5 才是 uuid + password。
  assert.match(tuic, /^TUIC = tuic-v5, 1\.2\.3\.4, 20001, uuid=uuid-1, password=tuic-pass/);

  const at = renderProxySubscription(only(ANYTLS, "AT"), "surge").trim();
  assert.match(at, /^AT = anytls, 1\.2\.3\.4, 20001, password=at-pass/);
});

test("Surge 的 gecko 混淆用另一个参数名", () => {
  const line = renderProxySubscription(only(HY2_GECKO, "HY2G"), "surge").trim();
  assert.match(line, /gecko-password=ob/);
  assert.doesNotMatch(line, /salamander-password/);
});

test("Quantumult X 一个 QUIC 系协议都不支持，逐个说明跳过原因", () => {
  const document = {
    nodes: [
      node(HY2, { address: "1.2.3.4", port: 20001, name: "HY2" }),
      node(TUIC, { address: "1.2.3.4", port: 20002, name: "TUIC" }),
      node(ANYTLS, { address: "1.2.3.4", port: 20003, name: "AT" }),
      node(TROJAN, { address: "5.6.7.8", port: 20004, name: "TJ" }),
    ],
    groups: [],
    ruleSets: [],
    rules: [],
  };

  const lines = renderProxySubscription(document, "quantumultx").trim().split("\n");

  assert.equal(lines.length, 5);
  assert.match(lines[0], /HY2.+不支持 Hysteria2/);
  assert.match(lines[1], /TUIC.+不支持 TUIC/);
  assert.match(lines[2], /AT.+不支持 AnyTLS/);
  assert.match(lines[3], /^#/);
  // trojan 照常渲染，不受跳过影响。
  assert.match(lines[4], /^trojan=5\.6\.7\.8:20004/);
});

test("base64 订阅原样带出三种新协议的链接", () => {
  const document = {
    nodes: [
      node(HY2, { address: "1.2.3.4", port: 20001, name: "HY2" }),
      node(TUIC, { address: "1.2.3.4", port: 20002, name: "TUIC" }),
      node(ANYTLS, { address: "1.2.3.4", port: 20003, name: "AT" }),
    ],
    groups: [],
    ruleSets: [],
    rules: [],
  };

  const links = decodeBase64Utf8(renderProxySubscription(document, "base64")).trim().split("\n");

  assert.equal(links.length, 3);
  assert.ok(links[0].startsWith("hysteria2://hy2-pass@1.2.3.4:20001/"));
  assert.match(links[0], /obfs=salamander/);
  assert.ok(links[1].startsWith("tuic://uuid-1:tuic-pass@1.2.3.4:20002?"));
  assert.ok(links[2].startsWith("anytls://at-pass@1.2.3.4:20003/"));
});
