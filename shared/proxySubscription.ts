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

export const PROXY_SUBSCRIPTION_FORMATS = ["base64", "clash", "singbox", "loon"] as const;

export type ProxySubscriptionFormat = (typeof PROXY_SUBSCRIPTION_FORMATS)[number];

export const PROXY_SUBSCRIPTION_FORMAT_LABELS: Record<ProxySubscriptionFormat, string> = {
  base64: "通用 Base64",
  clash: "Clash / mihomo",
  singbox: "sing-box",
  loon: "Loon",
};

export const PROXY_SUBSCRIPTION_FORMAT_HINTS: Record<ProxySubscriptionFormat, string> = {
  base64: "v2rayN、v2rayNG、Shadowrocket 等通用客户端。",
  clash: "Clash、Clash.Meta、mihomo、Stash。",
  singbox: "sing-box 及基于它的客户端。",
  loon: "Loon（iOS）。",
};

export const PROXY_SUBSCRIPTION_FORMAT_CONTENT_TYPES: Record<ProxySubscriptionFormat, string> = {
  base64: "text/plain; charset=utf-8",
  clash: "text/yaml; charset=utf-8",
  singbox: "application/json; charset=utf-8",
  loon: "text/plain; charset=utf-8",
};

export function normalizeProxySubscriptionFormat(value: unknown): ProxySubscriptionFormat {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "clash" || raw === "meta" || raw === "mihomo" || raw === "stash") return "clash";
  if (raw === "singbox" || raw === "sing-box") return "singbox";
  if (raw === "loon") return "loon";
  return "base64";
}

/** 订阅里的分组名，各格式统一使用，方便用户在不同客户端之间对照。 */
export const PROXY_SUBSCRIPTION_GROUP_NAME = "ForwardX";

function yamlQuote(value: string): string {
  return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderBase64(nodes: readonly ProxyNode[]): string {
  return encodeBase64Utf8(nodes.map((node) => formatProxyNodeLink(node)).join("\n"));
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

function renderClash(nodes: readonly ProxyNode[]): string {
  const lines: string[] = [nodes.length === 0 ? "proxies: []" : "proxies:"];
  for (const node of nodes) {
    for (const line of clashProxyLines(node)) {
      lines.push(`${" ".repeat(line.indent)}${line.text}`);
    }
  }

  const names = nodes.map((node) => yamlQuote(node.name));
  lines.push("proxy-groups:");
  lines.push(`  - name: ${yamlQuote(PROXY_SUBSCRIPTION_GROUP_NAME)}`);
  lines.push("    type: select");
  lines.push(`    proxies: [${names.join(", ")}]`);
  lines.push("rules:");
  lines.push(`  - MATCH,${PROXY_SUBSCRIPTION_GROUP_NAME}`);
  return `${lines.join("\n")}\n`;
}

function singboxOutbound(node: ProxyNode): Record<string, unknown> {
  const outbound: Record<string, unknown> = {
    tag: node.name,
    server: node.address,
    server_port: node.port,
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

function renderSingbox(nodes: readonly ProxyNode[]): string {
  const outbounds: Record<string, unknown>[] = nodes.map(singboxOutbound);
  const config = {
    outbounds: [
      {
        type: "selector",
        tag: PROXY_SUBSCRIPTION_GROUP_NAME,
        outbounds: nodes.map((node) => node.name),
      },
      ...outbounds,
      { type: "direct", tag: "direct" },
    ],
  };
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
  options.push(`udp=${node.udp ? "true" : "false"}`);

  return `${name} = ${[...parts, ...options].join(",")}`;
}

function renderLoon(nodes: readonly ProxyNode[]): string {
  return `${nodes.map(loonNodeLine).join("\n")}\n`;
}

export function renderProxySubscription(
  nodes: readonly ProxyNode[],
  format: ProxySubscriptionFormat,
): string {
  if (format === "clash") return renderClash(nodes);
  if (format === "singbox") return renderSingbox(nodes);
  if (format === "loon") return renderLoon(nodes);
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
