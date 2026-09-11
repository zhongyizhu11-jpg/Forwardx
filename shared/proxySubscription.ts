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
  PROXY_NODE_PROTOCOL_LABELS,
  proxyNodeAlwaysTls,
  proxyNodeRequiresUdp,
  type ProxyNode,
  type ProxyNodeProtocol,
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
  base64: "v2rayN、v2rayNG、Shadowrocket 等通用客户端。不支持 Snell（该协议没有分享链接）。",
  clash: "Clash、Clash.Meta、mihomo、Stash。协议最全，Snell 到 v5。",
  singbox: "sing-box 及基于它的客户端。协议最全，不支持 XHTTP 传输。",
  loon: "Loon（iOS）。不支持 TUIC、Snell、XHTTP。",
  surge: "Surge（iOS/Mac）与 Surfboard（Android）。不支持 VLESS、REALITY、XHTTP。",
  quantumultx: "Quantumult X（iOS）。不支持 Hysteria2 / TUIC / AnyTLS / Snell / REALITY / XHTTP。",
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

/**
 * base64 订阅是一串节点 URI，格式本身没有注释的位置 —— 塞一行 `#` 说明有可能
 * 让个别客户端整份订阅解析失败。所以这里只能静默跳过，跳过的原因写在面板的
 * 格式说明里（PROXY_SUBSCRIPTION_FORMAT_HINTS）。
 */
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

  /**
   * Hysteria2 / TUIC / AnyTLS 的字段自成一套：没有 network 与 ws-opts，TLS 也不是
   * 「tls: true + servername」那两个键，而是直接写 sni + skip-cert-verify。
   * 混进下面那套通用逻辑只会产出 mihomo 读不懂的键，所以单开一条分支并直接返回。
   */
  // Snell 走裸 TCP，没有 TLS 也没有 streamSettings；混淆是 obfs-opts 子块。
  if (node.protocol === "snell") {
    field("type", "snell");
    field("psk", yamlQuote(node.password));
    field("version", String(node.snellVersion || 1));
    // v1/v2 没有 UDP；写了也不会生效，不如不写。
    if ((node.snellVersion || 1) >= 3) field("udp", node.udp ? "true" : "false");
    if (node.obfs && node.obfs !== "none") {
      field("obfs-opts", "");
      push(6, `mode: ${yamlQuote(node.obfs)}`);
      if (node.host) push(6, `host: ${yamlQuote(node.host)}`);
    }
    if (node.frontProxyName) field("dialer-proxy", yamlQuote(node.frontProxyName));
    return lines;
  }

  if (node.protocol === "hysteria2" || node.protocol === "tuic" || node.protocol === "anytls") {
    if (node.protocol === "hysteria2") {
      field("type", "hysteria2");
      field("password", yamlQuote(node.password));
      if (node.obfs) {
        field("obfs", yamlQuote(node.obfs));
        if (node.obfsPassword) field("obfs-password", yamlQuote(node.obfsPassword));
      }
    } else if (node.protocol === "tuic") {
      field("type", "tuic");
      field("uuid", yamlQuote(node.uuid));
      field("password", yamlQuote(node.password));
      // mihomo 这里叫 congestion-controller，sing-box 叫 congestion_control，别混。
      if (node.congestionControl) field("congestion-controller", yamlQuote(node.congestionControl));
      if (node.udpRelayMode) field("udp-relay-mode", yamlQuote(node.udpRelayMode));
      if (node.disableSni) field("disable-sni", "true");
    } else {
      field("type", "anytls");
      field("password", yamlQuote(node.password));
      if (node.fingerprint) field("client-fingerprint", yamlQuote(node.fingerprint));
      // udp 只在 anytls 的文档字段表里；hysteria2 与 tuic 本身跑在 QUIC 上，没这个键。
      field("udp", node.udp ? "true" : "false");
    }
    if (node.sni) field("sni", yamlQuote(node.sni));
    if (node.alpn.length) field("alpn", `[${node.alpn.map((item) => yamlQuote(item)).join(", ")}]`);
    if (node.allowInsecure) field("skip-cert-verify", "true");
    if (node.frontProxyName) field("dialer-proxy", yamlQuote(node.frontProxyName));
    return lines;
  }

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
  } else if (node.transport === "httpupgrade") {
    // mihomo 的 httpupgrade 复用 ws-opts 放 path 与 Host，不是另起一个 opts 块。
    field("network", "httpupgrade");
    field("ws-opts", "");
    if (node.path) push(6, `path: ${yamlQuote(node.path)}`);
    if (node.host) {
      push(6, "headers:");
      push(8, `Host: ${yamlQuote(node.host)}`);
    }
  } else if (node.transport === "xhttp") {
    field("network", "xhttp");
    field("xhttp-opts", "");
    if (node.path) push(6, `path: ${yamlQuote(node.path)}`);
    if (node.host) push(6, `host: ${yamlQuote(node.host)}`);
    // mode 决定上下行怎么拆包，两端不一致就连不上，不是可选项。
    if (node.xhttpMode) push(6, `mode: ${yamlQuote(node.xhttpMode)}`);
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
  notices: readonly string[],
): string {
  const lines: string[] = [...notices, nodes.length === 0 ? "proxies: []" : "proxies:"];
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
  } else if (node.protocol === "hysteria2") {
    outbound.type = "hysteria2";
    outbound.password = node.password;
    if (node.obfs) {
      outbound.obfs = { type: node.obfs, ...(node.obfsPassword ? { password: node.obfsPassword } : {}) };
    }
  } else if (node.protocol === "tuic") {
    outbound.type = "tuic";
    outbound.uuid = node.uuid;
    if (node.password) outbound.password = node.password;
    // sing-box 用下划线命名，mihomo 用连字符且键名还不一样，两边不能照抄。
    if (node.congestionControl) outbound.congestion_control = node.congestionControl;
    if (node.udpRelayMode) outbound.udp_relay_mode = node.udpRelayMode;
  } else if (node.protocol === "anytls") {
    outbound.type = "anytls";
    outbound.password = node.password;
  } else if (node.protocol === "snell") {
    outbound.type = "snell";
    outbound.psk = node.password;
    // sing-box 的 Snell 只认 v4 与 v6。v5 与 v4 线格式一致，按 v4 发即可。
    outbound.version = (node.snellVersion || 1) === 6 ? 6 : 4;
    if ((node.snellVersion || 1) === 6) {
      if (node.snellMode) outbound.mode = node.snellMode;
    } else if (node.obfs && node.obfs !== "none") {
      outbound.obfs_mode = node.obfs;
      if (node.host) outbound.obfs_host = node.host;
    }
  } else {
    outbound.type = "shadowsocks";
    outbound.method = node.method;
    outbound.password = node.password;
  }

  if (node.tls || proxyNodeAlwaysTls(node.protocol)) {
    const tls: Record<string, unknown> = { enabled: true };
    if (node.sni) tls.server_name = node.sni;
    if (node.allowInsecure) tls.insecure = true;
    if (node.alpn.length) tls.alpn = [...node.alpn];
    // TUIC 的「握手不带 SNI」在 sing-box 里是 TLS 选项，不是出站字段。
    if (node.protocol === "tuic" && node.disableSni) tls.disable_sni = true;
    // uTLS 是给 TCP 上的 TLS 指纹伪装用的，QUIC 系协议没有这一层，写了也是无效键。
    if (node.fingerprint && !proxyNodeRequiresUdp(node.protocol)) {
      tls.utls = { enabled: true, fingerprint: node.fingerprint };
    }
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
  } else if (node.transport === "httpupgrade") {
    // host 是单个字符串，不是 http 那样的数组。
    outbound.transport = {
      type: "httpupgrade",
      ...(node.path ? { path: node.path } : {}),
      ...(node.host ? { host: node.host } : {}),
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
 * 各家客户端各自缺哪些协议。
 *
 * 依据都是官方手册，不是印象：
 *   Loon        手册的协议列表里有 Hysteria2，没有 TUIC。AnyTLS 手册未列，但
 *               Loon 已支持（Sub-Store 的 Loon 产出器有 anytls 分支），故不跳过。
 *   Surge       策略列表里有 Hysteria 2 / TUIC v5 / AnyTLS，唯独没有 VLESS。
 *   Quantumult X 至今只有 SS / VMess / Trojan / VLESS 那一套，QUIC 系一个都没有。
 *
 * 与其编出一行客户端读不懂的配置，不如跳过并在文件开头写明原因 —— 否则用户
 * 只会看到节点凭空少了，跟协议毫无字面关联。
 */
const FORMAT_UNSUPPORTED_PROTOCOLS: Record<ProxySubscriptionFormat, readonly ProxyNodeProtocol[]> = {
  // Snell 没有分享链接，base64 订阅是 URI 列表，装不下它。
  base64: ["snell"],
  clash: [],
  singbox: [],
  loon: ["tuic", "snell"],
  surge: ["vless"],
  quantumultx: ["hysteria2", "tuic", "anytls", "snell"],
};

/** 能表达 REALITY 的格式。Surge 与 Quantumult X 的手册里根本没有这一层。 */
const FORMATS_WITH_REALITY: readonly ProxySubscriptionFormat[] = ["base64", "clash", "singbox", "loon"];

/** 能表达 XHTTP 传输的格式。这是 Xray 的传输，只有 mihomo 跟进了。 */
const FORMATS_WITH_XHTTP: readonly ProxySubscriptionFormat[] = ["base64", "clash"];

/**
 * 认得 HTTPUpgrade 的格式。
 *
 * sing-box 原生支持（两端都验过），mihomo 用 `network: httpupgrade`，
 * v2rayN 系的链接写 `type=httpupgrade`。Loon / Surge / QX 没有这个传输，
 * 照常渲染的话会得到一个协议对、传输错的节点 —— 能导入、握手必失败。
 */
const FORMATS_WITH_HTTPUPGRADE: readonly ProxySubscriptionFormat[] = ["base64", "clash", "singbox"];

/**
 * 这个格式支持这个 Snell 版本吗？
 *
 * 版本对不上不是「少一个参数」，是握手完全不兼容，所以按版本逐家判断：
 *   Surge     v1-v6 全支持，但 v6 不能带 obfs
 *   mihomo    v1-v5
 *   sing-box  v4 与 v6；v5 与 v4 线格式一致，按 v4 发
 */
function snellUnsupportedReason(node: ProxyNode, format: ProxySubscriptionFormat): string {
  const version = node.snellVersion || 1;
  if (format === "clash" && version > 5) {
    return `mihomo 只支持到 Snell v5，这个节点是 v${version}`;
  }
  if (format === "singbox" && version !== 4 && version !== 5 && version !== 6) {
    return `sing-box 的 Snell 只有 v4 与 v6，这个节点是 v${version}`;
  }
  if (format === "surge" && version === 6 && node.obfs && node.obfs !== "none") {
    return `Surge 的 Snell v6 不支持混淆，这个节点带了 ${node.obfs}`;
  }
  return "";
}

/** 这个格式渲染不了这个节点吗？返回中文原因；空串表示能渲染。 */
function unsupportedReason(node: ProxyNode, format: ProxySubscriptionFormat): string {
  const label = PROXY_SUBSCRIPTION_FORMAT_LABELS[format];
  if (FORMAT_UNSUPPORTED_PROTOCOLS[format].includes(node.protocol)) {
    return `${label} 不支持 ${PROXY_NODE_PROTOCOL_LABELS[node.protocol]}`;
  }
  /**
   * REALITY 在 Surge 与 Quantumult X 里没有任何位置可写。
   *
   * 照常渲染的话会得到一个「普通 TLS」节点：能导入、能识别协议、握手必失败，
   * 而客户端只报一句连接失败 —— 与其如此，不如跳过并说清楚。这和 Loon 漏公钥
   * 是同一类静默失效。
   */
  if (node.realityPublicKey && !FORMATS_WITH_REALITY.includes(format)) {
    return `${label} 不支持 REALITY`;
  }
  // XHTTP 是 Xray 用来取代 H2 的传输，目前只有 mihomo 跟进。
  if (node.transport === "xhttp" && !FORMATS_WITH_XHTTP.includes(format)) {
    return `${label} 不支持 XHTTP 传输`;
  }
  if (node.transport === "httpupgrade" && !FORMATS_WITH_HTTPUPGRADE.includes(format)) {
    return `${label} 不支持 HTTPUpgrade 传输`;
  }
  if (node.protocol === "snell") {
    const reason = snellUnsupportedReason(node, format);
    if (reason) return reason;
  }
  // Loon 的 Hysteria2 只有 salamander-password 这一个混淆参数，gecko 没有位置可写。
  if (format === "loon" && node.protocol === "hysteria2" && node.obfs && node.obfs !== "salamander") {
    return `Loon 的 Hysteria2 只支持 salamander 混淆，这个节点用的是 ${node.obfs}`;
  }
  return "";
}

type SupportPartition = {
  supported: ProxyNode[];
  skipped: { node: ProxyNode; reason: string }[];
};

function partitionBySupport(nodes: readonly ProxyNode[], format: ProxySubscriptionFormat): SupportPartition {
  const supported: ProxyNode[] = [];
  const skipped: { node: ProxyNode; reason: string }[] = [];
  for (const node of nodes) {
    const reason = unsupportedReason(node, format);
    if (reason) skipped.push({ node, reason });
    else supported.push(node);
  }
  return { supported, skipped };
}

/** Clash（YAML）、Loon、Surge、Quantumult X 里 `#` 开头都是注释行，可以安全地写说明。 */
function skipNoticeLines(skipped: SupportPartition["skipped"]): string[] {
  if (skipped.length === 0) return [];
  return [
    ...skipped.map(({ node, reason }) => `# 已跳过节点「${node.name}」：${reason}`),
    "# 换一种格式的订阅地址即可，各格式支持的协议见面板上的说明。",
  ];
}

type FilteredDocument = ProxySubscriptionDocument & {
  /** 已带 `#` 前缀的说明行。JSON 与 base64 装不下注释，那两种格式拿到的是空数组。 */
  notices: string[];
};

/**
 * 按格式裁掉渲染不了的节点，并把策略组里对它们的引用一起清干净。
 *
 * 清引用这一步不能省：组是按名字引用成员的，留一个指向不存在节点的引用，Clash
 * 会拒绝整份配置，报的还是「订阅导入失败」这种毫无线索的错。空掉的组本身又是
 * 别人的成员（主选择器引用自动选路组），所以要反复清到不动为止。
 */
function filterForFormat(
  document: ProxySubscriptionDocument,
  format: ProxySubscriptionFormat,
): FilteredDocument {
  const { supported, skipped } = partitionBySupport(document.nodes, format);
  // JSON 没有注释语法；base64 是一整块编码，塞注释有可能让客户端整份解析失败。
  const notices = format === "singbox" || format === "base64" ? [] : skipNoticeLines(skipped);
  if (skipped.length === 0) return { ...document, notices };
  // 一个都不剩时连规则一起清掉：规则会指向不存在的策略组，客户端直接拒绝整份配置。
  if (supported.length === 0) return { nodes: [], groups: [], ruleSets: [], rules: [], notices };

  const removed = new Set(skipped.map(({ node }) => node.name));
  let groups = document.groups;
  for (;;) {
    const next = groups
      .map((group) => ({ ...group, members: group.members.filter((member) => !removed.has(member)) }))
      .filter((group) => {
        if (group.members.length > 0) return true;
        removed.add(group.name);
        return false;
      });
    const stable = next.length === groups.length;
    groups = next;
    if (stable) break;
  }

  return { nodes: supported, groups, ruleSets: document.ruleSets, rules: document.rules, notices };
}

/**
 * Loon 的 alpn 是逗号分隔并且要带引号 —— 节点行本身以逗号分隔，不加引号的话
 * 多个 alpn 会把整行拆错位。单个值加引号同样合法。
 */
function loonAlpn(node: ProxyNode): string {
  return node.alpn.length ? `alpn="${node.alpn.join(",")}"` : "";
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

  // Hysteria2 与 AnyTLS 没有 transport / over-tls 那一套，单独走一条分支。
  if (node.protocol === "hysteria2") {
    parts.push("Hysteria2", node.address, String(node.port), `"${node.password}"`);
    if (node.sni) options.push(`tls-name=${node.sni}`);
    options.push(`skip-cert-verify=${node.allowInsecure ? "true" : "false"}`);
    const alpn = loonAlpn(node);
    if (alpn) options.push(alpn);
    // Loon 只认 salamander，gecko 的节点已在 unsupportedReason 里跳掉了。
    if (node.obfsPassword && node.obfs === "salamander") {
      options.push(`salamander-password=${node.obfsPassword}`);
    }
    options.push(`udp=${node.udp ? "true" : "false"}`);
    return `${name} = ${[...parts, ...options].join(",")}`;
  }
  if (node.protocol === "anytls") {
    parts.push("anytls", node.address, String(node.port), `"${node.password}"`);
    options.push(`skip-cert-verify=${node.allowInsecure ? "true" : "false"}`);
    if (node.sni) options.push(`tls-name=${node.sni}`);
    const alpn = loonAlpn(node);
    if (alpn) options.push(alpn);
    return `${name} = ${[...parts, ...options].join(",")}`;
  }

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
    const alpn = loonAlpn(node);
    if (alpn) options.push(alpn);
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

function renderLoon(nodes: readonly ProxyNode[], notices: readonly string[]): string {
  return `${[...notices, ...markUnchainable(nodes).map(loonNodeLine)].join("\n")}\n`;
}

/**
 * 渲染订阅。base64 与 Loon 只输出节点，分组会被忽略 —— 见
 * PROXY_SUBSCRIPTION_FORMATS_WITH_GROUPS 的说明。
 */
function surgeNodeLine(node: ProxyNode): string {
  const parts: string[] = [];
  const name = node.name.replace(/[,=]/g, " ").replace(/\s+/g, " ").trim() || "node";

  if (node.protocol === "vmess") {
    parts.push("vmess", node.address, String(node.port), `username=${node.uuid}`);
  } else if (node.protocol === "trojan") {
    parts.push("trojan", node.address, String(node.port), `password=${node.password}`);
  } else if (node.protocol === "hysteria2") {
    parts.push("hysteria2", node.address, String(node.port), `password=${node.password}`);
    // Surge 的混淆按类型分成两个参数名，没有统一的 obfs 键。
    if (node.obfsPassword && node.obfs === "salamander") parts.push(`salamander-password=${node.obfsPassword}`);
    if (node.obfsPassword && node.obfs === "gecko") parts.push(`gecko-password=${node.obfsPassword}`);
  } else if (node.protocol === "tuic") {
    // Surge 把 v4 和 v5 当成两种策略类型，v5 才是 uuid + password 这一套。
    parts.push("tuic-v5", node.address, String(node.port), `uuid=${node.uuid}`, `password=${node.password}`);
  } else if (node.protocol === "anytls") {
    parts.push("anytls", node.address, String(node.port), `password=${node.password}`);
  } else if (node.protocol === "snell") {
    // Snell 是 Surge 自家的协议，psk 按手册惯例带引号。
    parts.push("snell", node.address, String(node.port), `psk="${node.password}"`);
    parts.push(`version=${node.snellVersion || 1}`);
    if ((node.snellVersion || 1) === 6) {
      if (node.snellMode) parts.push(`mode=${node.snellMode}`);
    } else if (node.obfs && node.obfs !== "none") {
      parts.push(`obfs=${node.obfs}`);
      if (node.host) parts.push(`obfs-host=${node.host}`);
    }
  } else {
    parts.push("ss", node.address, String(node.port), `encrypt-method=${node.method}`, `password=${node.password}`);
  }

  // Surge 的节点行本身以逗号分隔，alpn 写多个值会把行拆错位，所以只取第一个。
  // Hysteria2 与 TUIC 的默认 alpn 就是 h3，落地机基本不会给第二个值。
  if (node.alpn.length && (node.protocol === "hysteria2" || node.protocol === "tuic" || node.protocol === "anytls")) {
    parts.push(`alpn=${node.alpn[0]}`);
  }

  // 前置代理：Surge 的节点行参数，值是另一个节点或策略组的名字。
  if (node.frontProxyName) parts.push(`underlying-proxy=${node.frontProxyName}`);

  if (node.transport === "ws") {
    parts.push("ws=true");
    if (node.path) parts.push(`ws-path=${node.path}`);
    // Surge 的 ws-headers 是 `键:值` 用 | 分隔，不是 JSON。
    if (node.host) parts.push(`ws-headers=Host:${node.host}`);
  }

  if (node.tls || proxyNodeAlwaysTls(node.protocol)) {
    // trojan / hysteria2 / tuic / anytls 本身即 TLS，Surge 不接受它们再带 tls=true。
    if (!proxyNodeAlwaysTls(node.protocol)) parts.push("tls=true");
    if (node.sni) parts.push(`sni=${node.sni}`);
    parts.push(`skip-cert-verify=${node.allowInsecure ? "true" : "false"}`);
  }
  // Hysteria2 / TUIC / AnyTLS 的 UDP 转发是协议自带的，Surge 手册明说不需要这个参数。
  const carriesUdpItself = node.protocol === "hysteria2" || node.protocol === "tuic" || node.protocol === "anytls";
  if (!carriesUdpItself) parts.push(`udp-relay=${node.udp ? "true" : "false"}`);

  return `${name} = ${parts.join(", ")}`;
}

function renderSurge(nodes: readonly ProxyNode[], notices: readonly string[]): string {
  return `${[...notices, ...nodes.map(surgeNodeLine)].join("\n")}\n`;
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

function renderQuantumultX(nodes: readonly ProxyNode[], notices: readonly string[]): string {
  return `${[...notices, ...markUnchainable(nodes).map(quantumultxNodeLine)].join("\n")}\n`;
}

export function renderProxySubscription(
  document: ProxySubscriptionDocument,
  format: ProxySubscriptionFormat,
): string {
  const { nodes, groups, ruleSets, rules, notices } = filterForFormat(document, format);
  if (format === "clash") return renderClash(nodes, groups, ruleSets, rules, notices);
  if (format === "singbox") return renderSingbox(nodes, groups, ruleSets, rules);
  if (format === "loon") return renderLoon(nodes, notices);
  if (format === "surge") return renderSurge(nodes, notices);
  if (format === "quantumultx") return renderQuantumultX(nodes, notices);
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
