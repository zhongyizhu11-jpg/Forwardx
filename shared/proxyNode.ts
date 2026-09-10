/**
 * 客户端节点模型。
 *
 * 端口转发规则本身只存 host:port，不含任何节点凭据（UUID、密码、加密方式、
 * TLS 参数都没有），因为 ForwardX 是四层转发器，并不知道目标端口后面跑的是
 * 什么协议。所以订阅功能要求用户把落地机的原始节点链接粘贴一次，这里把它
 * 解析成统一模型，之后由 proxySubscription.ts 渲染成各家客户端的格式。
 *
 * 注意与「套餐订阅」（subscription_plans / user_subscriptions）区分：那是计费
 * 概念，本文件全部是代理节点概念，命名一律用 proxy 前缀。
 */

// 循环引用：proxyNodeJson 也从这里取 createEmptyProxyNode 和类型。两边的使用都在
// 函数体内（延迟求值），运行时安全 —— proxyNode.test.ts 里有端到端用例实际验证这一点。
import { looksLikeProxyNodeJson, parseProxyNodeJson } from "./proxyNodeJson";

export const PROXY_NODE_PROTOCOLS = ["vless", "vmess", "trojan", "shadowsocks"] as const;

export type ProxyNodeProtocol = (typeof PROXY_NODE_PROTOCOLS)[number];

export const PROXY_NODE_PROTOCOL_LABELS: Record<ProxyNodeProtocol, string> = {
  vless: "VLESS",
  vmess: "VMess",
  trojan: "Trojan",
  shadowsocks: "Shadowsocks",
};

export const PROXY_NODE_TRANSPORTS = ["tcp", "ws", "grpc", "http"] as const;

export type ProxyNodeTransport = (typeof PROXY_NODE_TRANSPORTS)[number];

export type ProxyNode = {
  protocol: ProxyNodeProtocol;
  name: string;
  address: string;
  port: number;
  /** vless / vmess 的用户 ID */
  uuid: string;
  /** trojan / shadowsocks 的密码 */
  password: string;
  /** shadowsocks 的加密方式，或 vmess 的 security */
  method: string;
  /** vmess 的 alterId，现代节点一律为 0 */
  alterId: number;
  /** vless 的流控，例如 xtls-rprx-vision */
  flow: string;
  transport: ProxyNodeTransport;
  /** ws / http 的路径，grpc 时存 serviceName */
  path: string;
  /** ws / http 的 Host 头 */
  host: string;
  tls: boolean;
  sni: string;
  alpn: string[];
  fingerprint: string;
  allowInsecure: boolean;
  /** Reality 公钥，非空表示该节点用 Reality 而非普通 TLS */
  realityPublicKey: string;
  realityShortId: string;
  udp: boolean;
};

export function createEmptyProxyNode(): ProxyNode {
  return {
    protocol: "vless",
    name: "",
    address: "",
    port: 0,
    uuid: "",
    password: "",
    method: "",
    alterId: 0,
    flow: "",
    transport: "tcp",
    path: "",
    host: "",
    tls: false,
    sni: "",
    alpn: [],
    fingerprint: "",
    allowInsecure: false,
    realityPublicKey: "",
    realityShortId: "",
    udp: true,
  };
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function toPort(value: unknown): number {
  const port = Number(text(value));
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

function normalizeTransport(value: unknown): ProxyNodeTransport {
  const raw = text(value).toLowerCase();
  // v2ray 的 net=h2 与 type=http 是同一种传输，统一收敛成 http。
  if (raw === "h2" || raw === "http") return "http";
  if (raw === "ws" || raw === "websocket") return "ws";
  if (raw === "grpc") return "grpc";
  return "tcp";
}

function splitAlpn(value: unknown): string[] {
  return text(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isTruthyFlag(value: unknown): boolean {
  const raw = text(value).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** UTF-8 安全的 base64 解码，容忍 URL-safe 变体和缺失的补位。 */
export function decodeBase64Utf8(input: string): string {
  let normalized = text(input).replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  if (!normalized) return "";
  const remainder = normalized.length % 4;
  if (remainder === 2) normalized += "==";
  else if (remainder === 3) normalized += "=";
  else if (remainder === 1) return "";
  let binary = "";
  try {
    binary = atob(normalized);
  } catch {
    return "";
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

/** UTF-8 安全的 base64 编码；节点名常含中文，不能直接 btoa。 */
export function encodeBase64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(String(input ?? ""));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function stripScheme(link: string, scheme: string): string {
  return link.slice(scheme.length);
}

function parseFragmentName(fragment: string): string {
  if (!fragment) return "";
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

type SplitLink = {
  body: string;
  query: URLSearchParams;
  name: string;
};

/** 把 `凭据@地址:端口?查询#名称` 拆开。不用 URL 是因为部分链接的凭据段不是合法 userinfo。 */
function splitLink(rest: string): SplitLink {
  let working = rest;
  let name = "";
  const hashIndex = working.indexOf("#");
  if (hashIndex >= 0) {
    name = parseFragmentName(working.slice(hashIndex + 1));
    working = working.slice(0, hashIndex);
  }
  let query = new URLSearchParams();
  const queryIndex = working.indexOf("?");
  if (queryIndex >= 0) {
    query = new URLSearchParams(working.slice(queryIndex + 1));
    working = working.slice(0, queryIndex);
  }
  return { body: working, query, name };
}

type HostPort = { address: string; port: number };

/** 从 `地址:端口` 取出两段，兼容 `[v6]:端口` 字面量。 */
function splitHostPort(value: string): HostPort {
  const raw = text(value).replace(/\/+$/, "");
  if (!raw) return { address: "", port: 0 };
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    if (close < 0) return { address: "", port: 0 };
    const address = raw.slice(1, close);
    const remainder = raw.slice(close + 1);
    return { address, port: remainder.startsWith(":") ? toPort(remainder.slice(1)) : 0 };
  }
  const colon = raw.lastIndexOf(":");
  if (colon < 0) return { address: raw, port: 0 };
  return { address: raw.slice(0, colon), port: toPort(raw.slice(colon + 1)) };
}

function applyTlsQuery(node: ProxyNode, query: URLSearchParams) {
  const security = text(query.get("security")).toLowerCase();
  node.tls = security === "tls" || security === "reality" || security === "xtls";
  node.sni = text(query.get("sni")) || text(query.get("peer"));
  node.alpn = splitAlpn(query.get("alpn"));
  node.fingerprint = text(query.get("fp"));
  node.allowInsecure = isTruthyFlag(query.get("allowInsecure")) || isTruthyFlag(query.get("insecure"));
  if (security === "reality") {
    node.realityPublicKey = text(query.get("pbk"));
    node.realityShortId = text(query.get("sid"));
  }
}

function applyTransportQuery(node: ProxyNode, query: URLSearchParams) {
  node.transport = normalizeTransport(query.get("type") || query.get("net"));
  if (node.transport === "grpc") {
    node.path = text(query.get("serviceName")) || text(query.get("path"));
  } else {
    node.path = text(query.get("path"));
  }
  node.host = text(query.get("host"));
}

function parseVlessLink(link: string): ProxyNode | null {
  const { body, query, name } = splitLink(stripScheme(link, "vless://"));
  const at = body.lastIndexOf("@");
  if (at < 0) return null;
  const uuid = text(decodeURIComponent(body.slice(0, at)));
  const { address, port } = splitHostPort(body.slice(at + 1));
  if (!uuid || !address || !port) return null;
  const node = createEmptyProxyNode();
  node.protocol = "vless";
  node.name = name;
  node.address = address;
  node.port = port;
  node.uuid = uuid;
  node.flow = text(query.get("flow"));
  applyTransportQuery(node, query);
  applyTlsQuery(node, query);
  return node;
}

function parseTrojanLink(link: string): ProxyNode | null {
  const { body, query, name } = splitLink(stripScheme(link, "trojan://"));
  const at = body.lastIndexOf("@");
  if (at < 0) return null;
  const password = text(decodeURIComponent(body.slice(0, at)));
  const { address, port } = splitHostPort(body.slice(at + 1));
  if (!password || !address || !port) return null;
  const node = createEmptyProxyNode();
  node.protocol = "trojan";
  node.name = name;
  node.address = address;
  node.port = port;
  node.password = password;
  applyTransportQuery(node, query);
  applyTlsQuery(node, query);
  // Trojan 本身就跑在 TLS 上，链接里通常不写 security=tls。
  if (!text(query.get("security"))) node.tls = true;
  return node;
}

/** vmess:// 的主流形态是 base64(JSON)，字段名沿用 v2rayN 的定义。 */
function parseVmessLink(link: string): ProxyNode | null {
  const decoded = decodeBase64Utf8(stripScheme(link, "vmess://"));
  if (!decoded) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
  const address = text(raw.add);
  const port = toPort(raw.port);
  const uuid = text(raw.id);
  if (!address || !port || !uuid) return null;
  const node = createEmptyProxyNode();
  node.protocol = "vmess";
  node.name = text(raw.ps);
  node.address = address;
  node.port = port;
  node.uuid = uuid;
  node.alterId = Number(text(raw.aid)) || 0;
  node.method = text(raw.scy) || "auto";
  node.transport = normalizeTransport(raw.net);
  node.path = node.transport === "grpc" ? text(raw.path) : text(raw.path);
  node.host = text(raw.host);
  const tls = text(raw.tls).toLowerCase();
  node.tls = tls === "tls" || tls === "reality";
  node.sni = text(raw.sni);
  node.alpn = splitAlpn(raw.alpn);
  node.fingerprint = text(raw.fp);
  return node;
}

/**
 * ss:// 有两种历史形态：
 *   SIP002  ss://base64url(method:password)@host:port#name
 *   旧版     ss://base64(method:password@host:port)#name
 */
function parseShadowsocksLink(link: string): ProxyNode | null {
  const { body, query, name } = splitLink(stripScheme(link, "ss://"));
  const node = createEmptyProxyNode();
  node.protocol = "shadowsocks";
  node.name = name;

  const at = body.lastIndexOf("@");
  if (at >= 0) {
    const credential = body.slice(0, at);
    const decoded = decodeBase64Utf8(credential) || text(decodeURIComponent(credential));
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    node.method = decoded.slice(0, separator).trim();
    node.password = decoded.slice(separator + 1).trim();
    const { address, port } = splitHostPort(body.slice(at + 1));
    node.address = address;
    node.port = port;
  } else {
    const decoded = decodeBase64Utf8(body);
    const innerAt = decoded.lastIndexOf("@");
    if (innerAt < 0) return null;
    const credential = decoded.slice(0, innerAt);
    const separator = credential.indexOf(":");
    if (separator < 0) return null;
    node.method = credential.slice(0, separator).trim();
    node.password = credential.slice(separator + 1).trim();
    const { address, port } = splitHostPort(decoded.slice(innerAt + 1));
    node.address = address;
    node.port = port;
  }

  if (!node.method || !node.password || !node.address || !node.port) return null;
  // v2rayN 会把 ss 的传输参数放在查询串里，保留下来以免中转后丢配置。
  if (query.has("type")) applyTransportQuery(node, query);
  return node;
}

export type ParseProxyNodeResult =
  | { ok: true; node: ProxyNode }
  | { ok: false; error: string };

/** 解析单条节点链接。失败时返回可直接展示给用户的中文原因。 */
export function parseProxyNodeLink(input: unknown): ParseProxyNodeResult {
  const link = text(input);
  if (!link) return { ok: false, error: "节点链接为空" };

  // 粘的是 JSON（sing-box 出站、Clash 条目、v2rayN 的 VMess、或整份配置）走另一条路。
  if (looksLikeProxyNodeJson(link)) {
    const result = parseProxyNodeJson(link);
    if (!result.ok) return { ok: false, error: result.error };
    if (result.needsAddress) {
      return {
        ok: false,
        error: "这份配置里没有公网地址（服务端配置的 listen 通常是 0.0.0.0），请在「地址」栏补上落地机的地址",
      };
    }
    return { ok: true, node: result.node };
  }

  const lower = link.toLowerCase();
  let node: ProxyNode | null = null;
  if (lower.startsWith("vless://")) node = parseVlessLink(link);
  else if (lower.startsWith("vmess://")) node = parseVmessLink(link);
  else if (lower.startsWith("trojan://")) node = parseTrojanLink(link);
  else if (lower.startsWith("ss://")) node = parseShadowsocksLink(link);
  else {
    return {
      ok: false,
      error: `暂不支持该协议，目前支持 ${PROXY_NODE_PROTOCOLS.map((item) => PROXY_NODE_PROTOCOL_LABELS[item]).join(" / ")}`,
    };
  }
  if (!node) return { ok: false, error: "节点链接格式无法识别，请确认是从落地机原样复制的完整链接" };
  return { ok: true, node };
}

export type ProxyNodeRelayEntry = {
  address: string;
  port: number;
  name: string;
};

/**
 * 把节点改写成经中转入口访问的形态：只替换地址和端口，凭据与 TLS 参数原样保留。
 *
 * 关键细节：TLS 的 SNI 和 ws/http 的 Host 头若原本留空，客户端会退化成用连接
 * 地址填充。中转后连接地址变成入口 IP，握手就会带着 IP 当 SNI 发给落地机而
 * 失败。所以这里在改写地址前，先把原地址固化进 sni / host，避免这种静默失效。
 */
export function relayProxyNode(node: ProxyNode, entry: ProxyNodeRelayEntry): ProxyNode {
  const relayed: ProxyNode = { ...node, alpn: [...node.alpn] };
  if (relayed.tls && !relayed.sni) relayed.sni = node.address;
  if ((relayed.transport === "ws" || relayed.transport === "http") && !relayed.host) {
    relayed.host = node.address;
  }
  relayed.address = text(entry.address);
  relayed.port = toPort(entry.port);
  relayed.name = text(entry.name) || node.name;
  return relayed;
}

function appendQuery(params: URLSearchParams, key: string, value: string) {
  if (value) params.set(key, value);
}

function buildTransportQuery(node: ProxyNode, params: URLSearchParams) {
  params.set("type", node.transport);
  if (node.transport === "grpc") appendQuery(params, "serviceName", node.path);
  else appendQuery(params, "path", node.path);
  if (node.transport !== "tcp") appendQuery(params, "host", node.host);
}

function buildTlsQuery(node: ProxyNode, params: URLSearchParams) {
  if (node.realityPublicKey) {
    params.set("security", "reality");
    appendQuery(params, "pbk", node.realityPublicKey);
    appendQuery(params, "sid", node.realityShortId);
  } else if (node.tls) {
    params.set("security", "tls");
  } else {
    params.set("security", "none");
  }
  appendQuery(params, "sni", node.sni);
  if (node.alpn.length) params.set("alpn", node.alpn.join(","));
  appendQuery(params, "fp", node.fingerprint);
  if (node.allowInsecure) params.set("allowInsecure", "1");
}

function formatHostForUri(address: string): string {
  return address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
}

/** 把模型还原成节点链接，用于通用 base64 订阅。 */
export function formatProxyNodeLink(node: ProxyNode): string {
  const host = formatHostForUri(node.address);
  const fragment = node.name ? `#${encodeURIComponent(node.name)}` : "";
  if (node.protocol === "vmess") {
    const payload = {
      v: "2",
      ps: node.name,
      add: node.address,
      port: String(node.port),
      id: node.uuid,
      aid: String(node.alterId),
      scy: node.method || "auto",
      net: node.transport,
      type: "none",
      host: node.host,
      path: node.path,
      tls: node.tls ? "tls" : "",
      sni: node.sni,
      alpn: node.alpn.join(","),
      fp: node.fingerprint,
    };
    return `vmess://${encodeBase64Utf8(JSON.stringify(payload))}`;
  }
  if (node.protocol === "shadowsocks") {
    const credential = encodeBase64Utf8(`${node.method}:${node.password}`)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `ss://${credential}@${host}:${node.port}${fragment}`;
  }
  const params = new URLSearchParams();
  if (node.protocol === "vless") {
    params.set("encryption", "none");
    appendQuery(params, "flow", node.flow);
  }
  buildTlsQuery(node, params);
  buildTransportQuery(node, params);
  const credential = encodeURIComponent(node.protocol === "trojan" ? node.password : node.uuid);
  return `${node.protocol}://${credential}@${host}:${node.port}?${params.toString()}${fragment}`;
}
