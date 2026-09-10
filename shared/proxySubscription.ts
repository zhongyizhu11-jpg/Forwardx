/**
 * 把中转改写后的节点列表渲染成各家客户端的订阅格式。
 *
 * 四种格式的字段名彼此不通用，例如 TLS 的服务器名在 Clash 里 vless/vmess 叫
 * servername、trojan 叫 sni，在 sing-box 里叫 server_name，在 Loon 里叫
 * tls-name，所以每种格式各写一个渲染器，共用 proxyNode.ts 的统一模型。
 */

import {
  encodeBase64Utf8,
  formatProxyNodeLink,
  type ProxyNode,
} from "./proxyNode";
import type {
  ProxySubscriptionDocument,
  ProxySubscriptionGroup,
} from "./proxySubscriptionPlan";
import {
  mihomoRuleSetUrl,
  singboxRuleSetUrl,
  PROXY_PRIVATE_IP6_CIDRS,
  PROXY_PRIVATE_IP_CIDRS,
  PROXY_RULE_TARGET_DIRECT,
  PROXY_RULE_TARGET_REJECT,
  type ProxyRouteRule,
  type ProxyRuleSetRef,
} from "./proxyRuleset";

export const PROXY_SUBSCRIPTION_FORMATS = ["base64", "clash", "singbox", "loon", "surge", "quantumultx"] as const;

export type ProxySubscriptionFormat = (typeof PROXY_SUBSCRIPTION_FORMATS)[number];

export const PROXY_SUBSCRIPTION_FORMAT_LABELS: Record<ProxySubscriptionFormat, string> = {
  base64: "通用 Base64",
  clash: "Clash / mihomo",
  singbox: "sing-box",
  loon: "Loon",
  surge: "Surge / Surfboard",
  quantumultx: "Quantumult X",
};

export const PROXY_SUBSCRIPTION_FORMAT_HINTS: Record<ProxySubscriptionFormat, string> = {
  base64: "v2rayN、v2rayNG、Shadowrocket 等通用客户端。",
  clash: "Clash、Clash.Meta、mihomo、Stash。",
  singbox: "sing-box 及基于它的客户端。",
  loon: "Loon（iOS）。",
  surge: "Surge（iOS/Mac）与 Surfboard（Android）。Surge 不支持 VLESS，这类节点会被跳过。",
  quantumultx: "Quantumult X（iOS）。",
};

export const PROXY_SUBSCRIPTION_FORMAT_CONTENT_TYPES: Record<ProxySubscriptionFormat, string> = {
  base64: "text/plain; charset=utf-8",
  clash: "text/yaml; charset=utf-8",
  singbox: "application/json; charset=utf-8",
  loon: "text/plain; charset=utf-8",
  surge: "text/plain; charset=utf-8",
  quantumultx: "text/plain; charset=utf-8",
};

export function normalizeProxySubscriptionFormat(value: unknown): ProxySubscriptionFormat {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "clash" || raw === "meta" || raw === "mihomo" || raw === "stash") return "clash";
  if (raw === "singbox" || raw === "sing-box") return "singbox";
  if (raw === "loon") return "loon";
  // Surfboard 用的就是 Surge 的配置格式。
  if (raw === "surge" || raw === "surfboard") return "surge";
  if (raw === "quantumultx" || raw === "quanx" || raw === "qx") return "quantumultx";
  return "base64";
}

/** 订阅里的主选择器名，各格式统一使用，方便用户在不同客户端之间对照。 */
export const PROXY_SUBSCRIPTION_GROUP_NAME = "ForwardX";

/**
 * 只有这两种格式能表达策略组。
 *
 * base64 是节点 URI 列表，格式本身没有分组概念；Loon 的节点订阅同样只接受节点
 * 行，策略组要写在用户自己的配置文件里 —— 硬塞 [Proxy Group] 会让节点订阅解析
 * 失败，所以这里宁可不出组，也不产出会坏掉的内容。
 */
export const PROXY_SUBSCRIPTION_FORMATS_WITH_GROUPS: readonly ProxySubscriptionFormat[] = ["clash", "singbox"];

export function proxySubscriptionFormatSupportsGroups(format: ProxySubscriptionFormat): boolean {
  return PROXY_SUBSCRIPTION_FORMATS_WITH_GROUPS.includes(format);
}

function yamlQuote(value: string): string {
  return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * base64 / Loon / Quantumult X 的订阅格式没有前置代理的位置。
 *
 * 直接原样发出去是错的：用户会以为链路生效了，实际是绕过前置直连落地 —— 轻则
 * 走了条差路，重则落地根本不可直连。所以在名字上标出来，让人一眼看出这条还要
 * 在客户端里手连一次前置，而不是静默给出一个行为不符预期的节点。
 *
 * 不选择跳过：跳掉的话订阅里会凭空少一个节点，用户更没法排查。
 */
function markUnchainable(nodes: readonly ProxyNode[]): ProxyNode[] {
  return nodes.map((node) =>
    node.frontProxyName ? { ...node, name: `${node.name}（需手动接 ${node.frontProxyName}）` } : node,
  );
}

function renderBase64(nodes: readonly ProxyNode[]): string {
  return encodeBase64Utf8(markUnchainable(nodes).map((node) => formatProxyNodeLink(node)).join("\n"));
}

type YamlLine = { indent: number; text: string };

function clashProxyLines(node: ProxyNode): YamlLine[] {
  const lines: YamlLine[] = [];
  const push = (indent: number, text: string) => lines.push({ indent, text });

  push(2, `- name: ${yamlQuote(node.name)}`);
  // 值为空表示后面跟一个缩进子块（如 ws-opts），此时不能留下尾随空格。
  const field = (key: string, value: string) => push(4, value ? `${key}: ${value}` : `${key}:`);

  field("server", yamlQuote(node.address));
  field("port", String(node.port));

  if (node.protocol === "vless") {
    field("type", "vless");
    field("uuid", yamlQuote(node.uuid));
    if (node.flow) field("flow", yamlQuote(node.flow));
  } else if (node.protocol === "vmess") {
    field("type", "vmess");
    field("uuid", yamlQuote(node.uuid));
    field("alterId", String(node.alterId));
    field("cipher", yamlQuote(node.method || "auto"));
  } else if (node.protocol === "trojan") {
    field("type", "trojan");
    field("password", yamlQuote(node.password));
  } else {
    field("type", "ss");
    field("cipher", yamlQuote(node.method));
    field("password", yamlQuote(node.password));
  }

  field("udp", node.udp ? "true" : "false");
  // 前置代理：这条连接先经由另一个节点建立。mihomo 的 dialer-proxy 是节点级字段，
  // 所以纯节点订阅也带得动，不必是完整配置。
  if (node.frontProxyName) field("dialer-proxy", yamlQuote(node.frontProxyName));

  if (node.tls || node.protocol === "trojan") {
    // Clash 的 trojan 用 sni，vless/vmess 用 servername，不能互换。
    if (node.protocol === "trojan") {
      if (node.sni) field("sni", yamlQuote(node.sni));
    } else {
      field("tls", "true");
      if (node.sni) field("servername", yamlQuote(node.sni));
    }
    if (node.allowInsecure) field("skip-cert-verify", "true");
    if (node.alpn.length) field("alpn", `[${node.alpn.map((item) => yamlQuote(item)).join(", ")}]`);
    if (node.fingerprint) field("client-fingerprint", yamlQuote(node.fingerprint));
    if (node.realityPublicKey) {
      field("reality-opts", "");
      push(6, `public-key: ${yamlQuote(node.realityPublicKey)}`);
      if (node.realityShortId) push(6, `short-id: ${yamlQuote(node.realityShortId)}`);
    }
  }

  if (node.transport === "ws") {
    field("network", "ws");
    field("ws-opts", "");
    if (node.path) push(6, `path: ${yamlQuote(node.path)}`);
    if (node.host) {
      push(6, "headers:");
      push(8, `Host: ${yamlQuote(node.host)}`);
    }
  } else if (node.transport === "grpc") {
    field("network", "grpc");
    field("grpc-opts", "");
    if (node.path) push(6, `grpc-service-name: ${yamlQuote(node.path)}`);
  } else if (node.transport === "http") {
    field("network", "http");
  }

  return lines;
}

/** 自动选路组的测速地址与节奏，Clash 与 sing-box 共用。 */
const PROXY_AUTO_GROUP_TEST_URL = "http://www.gstatic.com/generate_204";
const PROXY_AUTO_GROUP_INTERVAL_SECONDS = 300;
const PROXY_AUTO_GROUP_TOLERANCE_MS = 50;

/** 规则文件的本地缓存与更新间隔，各分类共用。 */
const PROXY_RULESET_CACHE_DIR = "./ruleset";
const PROXY_RULESET_INTERVAL_SECONDS = 86400;

function renderClash(
  nodes: readonly ProxyNode[],
  groups: readonly ProxySubscriptionGroup[],
  ruleSets: readonly ProxyRuleSetRef[],
  rules: readonly ProxyRouteRule[],
): string {
  const lines: string[] = [nodes.length === 0 ? "proxies: []" : "proxies:"];
  for (const node of nodes) {
    for (const line of clashProxyLines(node)) {
      lines.push(`${" ".repeat(line.indent)}${line.text}`);
    }
  }

  if (groups.length === 0) {
    lines.push("proxy-groups: []");
  } else {
    lines.push("proxy-groups:");
    for (const group of groups) {
      lines.push(`  - name: ${yamlQuote(group.name)}`);
      lines.push(`    type: ${group.type}`);
      lines.push(`    proxies: [${group.members.map((member) => yamlQuote(member)).join(", ")}]`);
      if (group.type !== "select") {
        lines.push(`    url: ${yamlQuote(PROXY_AUTO_GROUP_TEST_URL)}`);
        lines.push(`    interval: ${PROXY_AUTO_GROUP_INTERVAL_SECONDS}`);
        // 容差避免两条中转延迟接近时来回横跳，每次切换都会断开正在进行的连接。
        if (group.type === "url-test") lines.push(`    tolerance: ${PROXY_AUTO_GROUP_TOLERANCE_MS}`);
      }
    }
  }
  if (ruleSets.length > 0) {
    lines.push("rule-providers:");
    for (const ref of ruleSets) {
      lines.push(`  ${ref.name}:`);
      lines.push("    type: http");
      lines.push(`    behavior: ${ref.behavior}`);
      // mrs 是 mihomo 的二进制规则格式，体积和加载都比 yaml 省。
      lines.push("    format: mrs");
      lines.push(`    url: ${yamlQuote(mihomoRuleSetUrl(ref))}`);
      lines.push(`    path: ${yamlQuote(`${PROXY_RULESET_CACHE_DIR}/${ref.name}.mrs`)}`);
      lines.push(`    interval: ${PROXY_RULESET_INTERVAL_SECONDS}`);
    }
  }

  lines.push("rules:");
  if (rules.length > 0) {
    for (const rule of rules) {
      if (rule.type === "rule-set") {
        lines.push(`  - RULE-SET,${rule.ruleSet},${rule.target}${rule.noResolve ? ",no-resolve" : ""}`);
      } else if (rule.type === "ip-private") {
        // 直接列网段而不是引用外部规则集：局域网判断不该依赖一次网络下载。
        for (const cidr of PROXY_PRIVATE_IP_CIDRS) lines.push(`  - IP-CIDR,${cidr},${rule.target},no-resolve`);
        for (const cidr of PROXY_PRIVATE_IP6_CIDRS) lines.push(`  - IP-CIDR6,${cidr},${rule.target},no-resolve`);
      } else {
        lines.push(`  - MATCH,${rule.target}`);
      }
    }
  } else {
    // MATCH 必须指向真实存在的策略组，没有组时只能指 DIRECT，否则 Clash 会因为
    // 引用了不存在的组而拒绝整份配置。
    lines.push(`  - MATCH,${groups[0]?.name || PROXY_RULE_TARGET_DIRECT}`);
  }
  return `${lines.join("\n")}\n`;
}

function singboxOutbound(node: ProxyNode): Record<string, unknown> {
  const outbound: Record<string, unknown> = {
    tag: node.name,
    server: node.address,
    server_port: node.port,
    // 前置代理：sing-box 里叫 detour，指向另一个出站的 tag。
    ...(node.frontProxyName ? { detour: node.frontProxyName } : {}),
  };

  if (node.protocol === "vless") {
    outbound.type = "vless";
    outbound.uuid = node.uuid;
    if (node.flow) outbound.flow = node.flow;
  } else if (node.protocol === "vmess") {
    outbound.type = "vmess";
    outbound.uuid = node.uuid;
    outbound.alter_id = node.alterId;
    outbound.security = node.method || "auto";
  } else if (node.protocol === "trojan") {
    outbound.type = "trojan";
    outbound.password = node.password;
  } else {
    outbound.type = "shadowsocks";
    outbound.method = node.method;
    outbound.password = node.password;
  }

  if (node.tls || node.protocol === "trojan") {
    const tls: Record<string, unknown> = { enabled: true };
    if (node.sni) tls.server_name = node.sni;
    if (node.allowInsecure) tls.insecure = true;
    if (node.alpn.length) tls.alpn = [...node.alpn];
    if (node.fingerprint) tls.utls = { enabled: true, fingerprint: node.fingerprint };
    if (node.realityPublicKey) {
      tls.reality = {
        enabled: true,
        public_key: node.realityPublicKey,
        ...(node.realityShortId ? { short_id: node.realityShortId } : {}),
      };
    }
    outbound.tls = tls;
  }

  if (node.transport === "ws") {
    outbound.transport = {
      type: "ws",
      ...(node.path ? { path: node.path } : {}),
      ...(node.host ? { headers: { Host: node.host } } : {}),
    };
  } else if (node.transport === "grpc") {
    outbound.transport = { type: "grpc", ...(node.path ? { service_name: node.path } : {}) };
  } else if (node.transport === "http") {
    outbound.transport = {
      type: "http",
      ...(node.path ? { path: node.path } : {}),
      ...(node.host ? { host: [node.host] } : {}),
    };
  }

  return outbound;
}

function singboxGroupOutbound(group: ProxySubscriptionGroup): Record<string, unknown> {
  if (group.type === "select") {
    return { type: "selector", tag: group.name, outbounds: [...group.members] };
  }
  // sing-box 没有单独的 fallback 类型，两种模式都用 urltest 表达；它本身就带
  // 故障切换，主备与择快的差别只在成员顺序。
  return {
    type: "urltest",
    tag: group.name,
    outbounds: [...group.members],
    url: PROXY_AUTO_GROUP_TEST_URL,
    interval: `${PROXY_AUTO_GROUP_INTERVAL_SECONDS}s`,
    ...(group.type === "url-test" ? { tolerance: PROXY_AUTO_GROUP_TOLERANCE_MS } : {}),
  };
}

function singboxRouteTarget(target: string): Record<string, unknown> {
  // sing-box 1.11 起拦截用规则上的 action，不再是一个 block 出站。
  if (target === PROXY_RULE_TARGET_REJECT) return { action: "reject" };
  if (target === PROXY_RULE_TARGET_DIRECT) return { outbound: "direct" };
  return { outbound: target };
}

function renderSingbox(
  nodes: readonly ProxyNode[],
  groups: readonly ProxySubscriptionGroup[],
  ruleSets: readonly ProxyRuleSetRef[],
  rules: readonly ProxyRouteRule[],
): string {
  const config: Record<string, unknown> = {
    outbounds: [
      ...groups.map(singboxGroupOutbound),
      ...nodes.map(singboxOutbound),
      { type: "direct", tag: "direct" },
    ],
  };

  if (ruleSets.length > 0 || rules.length > 0) {
    // sing-geoip 只按国家代码发布，非国家的 IP 集在那边不存在，引用了会 404。
    const usableRuleSets = ruleSets.filter((ref) => !ref.mihomoOnly);
    const usableNames = new Set(usableRuleSets.map((ref) => ref.name));

    const routeRules: Record<string, unknown>[] = [];
    for (const rule of rules) {
      if (rule.type === "ip-private") {
        // sing-box 自带私有网段判断，不需要外部规则集。
        routeRules.push({ ip_is_private: true, ...singboxRouteTarget(rule.target) });
      } else if (rule.type === "rule-set" && usableNames.has(rule.ruleSet)) {
        routeRules.push({ rule_set: rule.ruleSet, ...singboxRouteTarget(rule.target) });
      }
    }

    const remoteRuleSets = usableRuleSets.map((ref) => ({
      type: "remote",
      tag: ref.name,
      format: "binary",
      url: singboxRuleSetUrl(ref),
      // 规则文件本身不该绕进代理，否则首次启动时代理还没就绪就取不到。
      download_detour: "direct",
    }));
    config.route = {
      // sing-box 没有「只给节点」的格式，节点订阅同样是完整 profile，
      // 所以即使没有分流规则也要给出 final，否则客户端会退回用第一个出站。
      ...(routeRules.length > 0 ? { rules: routeRules } : {}),
      ...(remoteRuleSets.length > 0 ? { rule_set: remoteRuleSets } : {}),
      // MATCH 在 sing-box 里是 route.final，不是一条规则。
      final: rules.find((rule) => rule.type === "match")?.target || "direct",
    };
  }

  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Loon 的节点行以逗号分隔、以 `=` 分隔名称与配置，所以名称里出现这两个字符会
 * 把整行解析错位，这里替换成安全字符而不是直接丢弃节点。
 */
function loonNodeName(name: string): string {
  return String(name ?? "").replace(/[,=]/g, " ").replace(/\s+/g, " ").trim() || "node";
}

function loonNodeLine(node: ProxyNode): string {
  const name = loonNodeName(node.name);
  const parts: string[] = [];
  const options: string[] = [];

  if (node.protocol === "vless") {
    parts.push("VLESS", node.address, String(node.port), `"${node.uuid}"`);
    if (node.flow) options.push(`flow=${node.flow}`);
  } else if (node.protocol === "vmess") {
    parts.push("vmess", node.address, String(node.port), node.method || "auto", `"${node.uuid}"`);
    options.push(`alterId=${node.alterId}`);
  } else if (node.protocol === "trojan") {
    parts.push("trojan", node.address, String(node.port), `"${node.password}"`);
  } else {
    parts.push("Shadowsocks", node.address, String(node.port), node.method, `"${node.password}"`);
  }

  if (node.protocol !== "shadowsocks") {
    options.push(`transport=${node.transport === "http" ? "http" : node.transport}`);
    if (node.path) options.push(`path=${node.path}`);
    if (node.host) options.push(`host=${node.host}`);
  }

  if (node.protocol === "vless" || node.protocol === "vmess") {
    options.push(`over-tls=${node.tls ? "true" : "false"}`);
  }
  if (node.tls || node.protocol === "trojan") {
    // 官方示例配置用的是 tls-name，新版文档里的 sni 只是别名，这里取兼容性更好的写法。
    if (node.sni) options.push(`tls-name=${node.sni}`);
    if (node.alpn.length) options.push(`alpn=${node.alpn.join(":")}`);
    options.push(`skip-cert-verify=${node.allowInsecure ? "true" : "false"}`);
  }
  // Reality。少了公钥就握不上手，而客户端只会报一句连接失败 —— 看不出缺的是参数。
  // 写法按 Loon 官方文档的 VLESS Reality 示例：public-key 带引号，short-id 不带。
  if (node.realityPublicKey) {
    options.push(`public-key="${node.realityPublicKey}"`);
    if (node.realityShortId) options.push(`short-id=${node.realityShortId}`);
  }
  options.push(`udp=${node.udp ? "true" : "false"}`);

  return `${name} = ${[...parts, ...options].join(",")}`;
}

function renderLoon(nodes: readonly ProxyNode[]): string {
  return `${markUnchainable(nodes).map(loonNodeLine).join("\n")}\n`;
}

/**
 * 渲染订阅。base64 与 Loon 只输出节点，分组会被忽略 —— 见
 * PROXY_SUBSCRIPTION_FORMATS_WITH_GROUPS 的说明。
 */
/**
 * Surge 原生不支持 VLESS（官方手册的协议列表里没有它，社区方案都是靠外部
 * sing-box 桥接）。与其编出一行 Surge 读不懂的配置，不如跳过并在文件里写明
 * 原因，否则用户只会看到节点凭空少了。
 */
const SURGE_UNSUPPORTED_PROTOCOLS = new Set<ProxyNode["protocol"]>(["vless"]);

function surgeNodeLine(node: ProxyNode): string {
  const parts: string[] = [];
  const name = node.name.replace(/[,=]/g, " ").replace(/\s+/g, " ").trim() || "node";

  if (node.protocol === "vmess") {
    parts.push("vmess", node.address, String(node.port), `username=${node.uuid}`);
  } else if (node.protocol === "trojan") {
    parts.push("trojan", node.address, String(node.port), `password=${node.password}`);
  } else {
    parts.push("ss", node.address, String(node.port), `encrypt-method=${node.method}`, `password=${node.password}`);
  }

  // 前置代理：Surge 的节点行参数，值是另一个节点或策略组的名字。
  if (node.frontProxyName) parts.push(`underlying-proxy=${node.frontProxyName}`);

  if (node.transport === "ws") {
    parts.push("ws=true");
    if (node.path) parts.push(`ws-path=${node.path}`);
    // Surge 的 ws-headers 是 `键:值` 用 | 分隔，不是 JSON。
    if (node.host) parts.push(`ws-headers=Host:${node.host}`);
  }

  if (node.tls || node.protocol === "trojan") {
    // trojan 本身即 TLS，Surge 不接受它再带 tls=true。
    if (node.protocol !== "trojan") parts.push("tls=true");
    if (node.sni) parts.push(`sni=${node.sni}`);
    parts.push(`skip-cert-verify=${node.allowInsecure ? "true" : "false"}`);
  }
  parts.push(`udp-relay=${node.udp ? "true" : "false"}`);

  return `${name} = ${parts.join(", ")}`;
}

function renderSurge(nodes: readonly ProxyNode[]): string {
  const supported = nodes.filter((node) => !SURGE_UNSUPPORTED_PROTOCOLS.has(node.protocol));
  const skipped = nodes.filter((node) => SURGE_UNSUPPORTED_PROTOCOLS.has(node.protocol));
  const lines: string[] = [];
  if (skipped.length > 0) {
    lines.push(`# Surge 不支持 VLESS，已跳过 ${skipped.length} 个节点：${skipped.map((node) => node.name).join("、")}`);
    lines.push("# 这些节点可以用 Clash、sing-box 或 Quantumult X 格式的订阅地址。");
  }
  lines.push(...supported.map(surgeNodeLine));
  return `${lines.join("\n")}\n`;
}

/**
 * Quantumult X 的字段名自成一套：传输方式叫 obfs，ws over TLS 是 obfs=wss，
 * 纯 TCP 加 TLS 是 obfs=over-tls，节点名叫 tag。
 */
function quantumultxNodeLine(node: ProxyNode): string {
  const parts: string[] = [];
  const target = `${node.address}:${node.port}`;

  if (node.protocol === "vless") {
    // VLESS 本身不加密，QX 要求 method 固定填 none。
    parts.push(`vless=${target}`, "method=none", `password=${node.uuid}`);
  } else if (node.protocol === "vmess") {
    parts.push(`vmess=${target}`, `method=${node.method && node.method !== "auto" ? node.method : "none"}`, `password=${node.uuid}`);
  } else if (node.protocol === "trojan") {
    parts.push(`trojan=${target}`, `password=${node.password}`);
  } else {
    parts.push(`shadowsocks=${target}`, `method=${node.method}`, `password=${node.password}`);
  }

  if (node.protocol === "trojan") {
    // trojan 在 QX 里用 over-tls / tls-host，而不是 obfs 那套。
    parts.push("over-tls=true");
    if (node.sni) parts.push(`tls-host=${node.sni}`);
  } else if (node.transport === "ws") {
    parts.push(node.tls ? "obfs=wss" : "obfs=ws");
    if (node.path) parts.push(`obfs-uri=${node.path}`);
    if (node.host || node.sni) parts.push(`obfs-host=${node.host || node.sni}`);
  } else if (node.tls) {
    parts.push("obfs=over-tls");
    if (node.sni) parts.push(`obfs-host=${node.sni}`);
  }

  if (node.tls || node.protocol === "trojan") {
    parts.push(`tls-verification=${node.allowInsecure ? "false" : "true"}`);
  }
  parts.push(`udp-relay=${node.udp ? "true" : "false"}`);
  // tag 放最后，QX 的惯例，也便于人眼扫读。
  parts.push(`tag=${node.name.replace(/,/g, " ").trim() || "node"}`);

  return parts.join(", ");
}

function renderQuantumultX(nodes: readonly ProxyNode[]): string {
  return `${markUnchainable(nodes).map(quantumultxNodeLine).join("\n")}\n`;
}

export function renderProxySubscription(
  document: ProxySubscriptionDocument,
  format: ProxySubscriptionFormat,
): string {
  const { nodes, groups, ruleSets, rules } = document;
  if (format === "clash") return renderClash(nodes, groups, ruleSets, rules);
  if (format === "singbox") return renderSingbox(nodes, groups, ruleSets, rules);
  if (format === "loon") return renderLoon(nodes);
  if (format === "surge") return renderSurge(nodes);
  if (format === "quantumultx") return renderQuantumultX(nodes);
  return renderBase64(nodes);
}

export type ProxySubscriptionUserInfo = {
  /** 已用上行字节 */
  upload: number;
  /** 已用下行字节 */
  download: number;
  /** 总额度字节，0 表示不限制 */
  total: number;
  /** 到期时间（秒级 Unix 时间戳），0 表示永不过期 */
  expire: number;
};

/**
 * 生成 Subscription-Userinfo 响应头。v2rayN、Clash、Loon 都会读它来显示已用
 * 流量和到期时间，字段单位是字节和秒级时间戳。
 */
export function formatProxySubscriptionUserInfo(info: ProxySubscriptionUserInfo): string {
  const safe = (value: unknown) => Math.max(0, Math.floor(Number(value) || 0));
  return [
    `upload=${safe(info.upload)}`,
    `download=${safe(info.download)}`,
    `total=${safe(info.total)}`,
    `expire=${safe(info.expire)}`,
  ].join("; ");
}
