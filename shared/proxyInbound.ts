/**
 * 落地节点（入站）。
 *
 * 与 proxyNode.ts 的分工：proxyNode 描述「客户端怎么连」，本文件描述「落地机怎么听」。
 * 两边共用协议、端口、凭据，差别在于 Reality 的私钥只存在这一侧 —— 发给客户端的
 * 是公钥。面板每保存一次入站就派生一份 ProxyNode 落进 proxy_nodes，订阅那一整套
 * （中转改写、前置代理、六种渲染器）原样接上，不必再动。
 *
 * 运行时选 sing-box：它的入站覆盖我们渲染的全部八个协议（vless / vmess / trojan /
 * shadowsocks / hysteria2 / tuic / anytls / snell），出站也一样，一个二进制两头都够，
 * 不必像别家那样维护一个 Xray 分支去 cherry-pick 协议实现。
 *
 * 本文件保持纯计算：客户端也会 import 它，所以不能碰 node:crypto。Reality 密钥对
 * 由服务端生成（私钥绝不能经过浏览器），这里只接收结果。
 */

import {
  createEmptyProxyNode,
  PROXY_NODE_PROTOCOL_LABELS,
  type ProxyNode,
  type ProxyNodeProtocol,
  type ProxyNodeTransport,
} from "./proxyNode";

/** 能作为落地节点开出去的协议。与 PROXY_NODE_PROTOCOLS 一致，因为两头都由 sing-box 承担。 */
export const PROXY_INBOUND_PROTOCOLS = [
  "vless",
  "vmess",
  "trojan",
  "shadowsocks",
  "hysteria2",
  "tuic",
  "anytls",
  "snell",
] as const;

export type ProxyInboundProtocol = (typeof PROXY_INBOUND_PROTOCOLS)[number];

export const PROXY_INBOUND_SECURITIES = ["reality", "tls", "none"] as const;

export type ProxyInboundSecurity = (typeof PROXY_INBOUND_SECURITIES)[number];

export const PROXY_INBOUND_SECURITY_LABELS: Record<ProxyInboundSecurity, string> = {
  reality: "REALITY",
  tls: "TLS",
  none: "无",
};

/**
 * REALITY 只能架在 TCP 上的 TLS 之上。
 *
 * Hysteria2 与 TUIC 跑在 QUIC 上，那一层没有 REALITY 的位置；Shadowsocks 与 Snell
 * 压根没有 TLS 层。AnyTLS 的服务端虽然能开 REALITY，但主流客户端（mihomo / Clash /
 * sing-box）都明说不会支持，开出来是一个没人连得上的节点，所以这里也不放行。
 */
export const PROXY_INBOUND_REALITY_PROTOCOLS: readonly ProxyInboundProtocol[] = ["vless", "vmess", "trojan"];

/** 协议自带 TLS，安全层不能选「无」。 */
const ALWAYS_TLS_PROTOCOLS: readonly ProxyInboundProtocol[] = ["trojan", "hysteria2", "tuic", "anytls"];

/** 压根没有 TLS 层的协议，安全层只能选「无」。 */
const NO_TLS_PROTOCOLS: readonly ProxyInboundProtocol[] = ["shadowsocks", "snell"];

/** 这个协议能选哪些安全层。UI 用它来收窄下拉，而不是让用户选完再报错。 */
export function proxyInboundSecurities(protocol: ProxyInboundProtocol): ProxyInboundSecurity[] {
  if (NO_TLS_PROTOCOLS.includes(protocol)) return ["none"];
  const securities: ProxyInboundSecurity[] = ["tls"];
  if (PROXY_INBOUND_REALITY_PROTOCOLS.includes(protocol)) securities.unshift("reality");
  if (!ALWAYS_TLS_PROTOCOLS.includes(protocol)) securities.push("none");
  return securities;
}

/**
 * 这个协议能选哪些传输。QUIC 系与裸 TCP 系都没有传输层可选。
 *
 * 注意没有 xhttp：那是 Xray 的传输，sing-box 不实现，所以我们开不出这样的落地。
 * 订阅渲染那一侧仍然支持 XHTTP —— 用户从别处拿到的 XHTTP 节点照常能粘进来、能中转。
 * 「能转发」和「能自建」是两件事，这里只管后者。
 */
export function proxyInboundTransports(protocol: ProxyInboundProtocol): ProxyNodeTransport[] {
  if (protocol === "vless" || protocol === "vmess" || protocol === "trojan") {
    return ["tcp", "ws", "grpc", "http"];
  }
  // shadowsocks / snell / hysteria2 / tuic / anytls 都只有一种承载。
  return ["tcp"];
}

export type ProxyInbound = {
  protocol: ProxyInboundProtocol;
  /** 面板里的名字，也会成为派生节点的默认名。 */
  name: string;
  /** 落地机上的监听端口。 */
  port: number;
  transport: ProxyNodeTransport;
  security: ProxyInboundSecurity;
  /** vless / vmess / tuic 的用户 ID */
  uuid: string;
  /** trojan / shadowsocks / hysteria2 / tuic / anytls 的密码，以及 snell 的 psk */
  password: string;
  /** shadowsocks 的加密方式 */
  method: string;
  /** vless 的流控，例如 xtls-rprx-vision */
  flow: string;
  /** ws / http 的路径，grpc 时是 serviceName */
  path: string;
  /** ws / http 的 Host */
  host: string;
  /** XHTTP 的 mode：auto / stream-one / stream-up / packet-up */
  xhttpMode: string;
  /** TLS 的服务器名。security=reality 时同时是要偷的握手域名。 */
  serverName: string;
  alpn: string[];
  /** security=tls 时的证书路径，落地机本地路径。 */
  certPath: string;
  keyPath: string;
  /** REALITY：私钥只在服务端，公钥才发给客户端。 */
  realityPrivateKey: string;
  realityPublicKey: string;
  realityShortId: string;
  /**
   * REALITY 的握手目标，形如 `dl.google.com:443`。
   * 留空时按 serverName:443 推导 —— 绝大多数情况这两者本来就该一致。
   */
  realityDest: string;
  /** Hysteria2 的混淆：salamander，空表示不混淆 */
  obfs: string;
  obfsPassword: string;
  /** Hysteria2 向客户端声明的带宽（Mbps），0 表示不限制 */
  upMbps: number;
  downMbps: number;
  /** TUIC 的拥塞控制：cubic / new_reno / bbr */
  congestionControl: string;
  /** Snell 的版本（4/5/6）与 v6 的整形模式 */
  snellVersion: number;
  snellMode: string;
};

export function createEmptyProxyInbound(): ProxyInbound {
  return {
    protocol: "vless",
    name: "",
    port: 0,
    transport: "tcp",
    security: "reality",
    uuid: "",
    password: "",
    method: "",
    flow: "",
    path: "",
    host: "",
    xhttpMode: "",
    serverName: "",
    alpn: [],
    certPath: "",
    keyPath: "",
    realityPrivateKey: "",
    realityPublicKey: "",
    realityShortId: "",
    realityDest: "",
    obfs: "",
    obfsPassword: "",
    upMbps: 0,
    downMbps: 0,
    congestionControl: "",
    snellVersion: 0,
    snellMode: "",
  };
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function toPort(value: unknown): number {
  const port = Number(text(value));
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

/** REALITY 的 short-id 是 0 到 8 字节的十六进制，也就是最多 16 个字符且长度为偶数。 */
export function isValidRealityShortId(value: unknown): boolean {
  const raw = text(value);
  if (!raw) return true;
  return raw.length <= 16 && raw.length % 2 === 0 && /^[0-9a-f]+$/i.test(raw);
}

/**
 * 校验入站配置。返回可直接展示给用户的中文原因，空串表示没问题。
 *
 * 这里挡住的都是「存得下去、但开出来连不上」的组合 —— 那类问题在客户端只表现为
 * 一句连接失败，看不出是配置本身不成立。
 */
export function validateProxyInbound(inbound: ProxyInbound): string {
  const label = PROXY_NODE_PROTOCOL_LABELS[inbound.protocol as ProxyNodeProtocol] || inbound.protocol;
  if (!toPort(inbound.port)) return "监听端口不合法";

  if (!proxyInboundSecurities(inbound.protocol).includes(inbound.security)) {
    if (inbound.security === "reality") {
      return `${label} 不能用 REALITY —— REALITY 只能架在 TCP 的 TLS 之上`;
    }
    if (inbound.security === "none") return `${label} 自带 TLS，安全层不能选「无」`;
    return `${label} 没有 TLS 层，安全层只能选「无」`;
  }

  if (!proxyInboundTransports(inbound.protocol).includes(inbound.transport)) {
    if (inbound.transport === "xhttp") {
      return "XHTTP 是 Xray 的传输，sing-box 开不出这样的落地；从别处拿到的 XHTTP 节点仍然可以粘进来中转";
    }
    return `${label} 不支持 ${inbound.transport} 传输`;
  }

  // 凭据：缺了就是一个谁都连不上的节点。
  if (inbound.protocol === "vless" || inbound.protocol === "vmess" || inbound.protocol === "tuic") {
    if (!text(inbound.uuid)) return "缺少 UUID";
  }
  if (inbound.protocol !== "vless" && inbound.protocol !== "vmess") {
    if (!text(inbound.password)) return inbound.protocol === "snell" ? "缺少 PSK" : "缺少密码";
  }
  if (inbound.protocol === "shadowsocks" && !text(inbound.method)) return "缺少加密方式";

  if (inbound.security === "reality") {
    if (!text(inbound.realityPrivateKey)) return "缺少 REALITY 私钥";
    if (!text(inbound.realityPublicKey)) return "缺少 REALITY 公钥";
    if (!text(inbound.serverName)) return "REALITY 需要一个要偷的握手域名";
    if (!isValidRealityShortId(inbound.realityShortId)) {
      return "REALITY 的 short-id 只能是 0 到 8 字节的十六进制（最多 16 个字符，且长度为偶数）";
    }
  }
  if (inbound.security === "tls" && (!text(inbound.certPath) || !text(inbound.keyPath))) {
    return "TLS 需要证书和私钥的路径";
  }
  // Snell v6 换成了流量整形，没有 obfs；v4/v5 才有。
  if (inbound.protocol === "snell") {
    const version = Number(inbound.snellVersion) || 0;
    if (version !== 4 && version !== 5 && version !== 6) return "Snell 版本只能是 4、5 或 6";
  }
  return "";
}

/** REALITY 的握手目标：显式填了就用，否则按握手域名的 443 推导。 */
export function proxyInboundRealityDest(inbound: ProxyInbound): { server: string; port: number } {
  const raw = text(inbound.realityDest) || `${text(inbound.serverName)}:443`;
  const colon = raw.lastIndexOf(":");
  if (colon <= 0) return { server: raw, port: 443 };
  return { server: raw.slice(0, colon), port: toPort(raw.slice(colon + 1)) || 443 };
}

function singboxServerTls(inbound: ProxyInbound): Record<string, unknown> | null {
  if (inbound.security === "none") return null;
  const tls: Record<string, unknown> = { enabled: true };
  if (inbound.serverName) tls.server_name = inbound.serverName;
  if (inbound.alpn.length) tls.alpn = [...inbound.alpn];
  if (inbound.security === "reality") {
    const dest = proxyInboundRealityDest(inbound);
    tls.reality = {
      enabled: true,
      handshake: { server: dest.server, server_port: dest.port },
      private_key: inbound.realityPrivateKey,
      // short_id 是数组，且允许空串 —— 空串表示不校验 short-id。
      short_id: [text(inbound.realityShortId)],
    };
  } else {
    tls.certificate_path = inbound.certPath;
    tls.key_path = inbound.keyPath;
  }
  return tls;
}

function singboxTransport(inbound: ProxyInbound): Record<string, unknown> | null {
  if (inbound.transport === "ws") {
    return {
      type: "ws",
      ...(inbound.path ? { path: inbound.path } : {}),
      ...(inbound.host ? { headers: { Host: inbound.host } } : {}),
    };
  }
  if (inbound.transport === "grpc") {
    return { type: "grpc", ...(inbound.path ? { service_name: inbound.path } : {}) };
  }
  if (inbound.transport === "http") {
    return {
      type: "http",
      ...(inbound.path ? { path: inbound.path } : {}),
      ...(inbound.host ? { host: [inbound.host] } : {}),
    };
  }
  // tcp 没有传输块。xhttp 走不到这里 —— validateProxyInbound 已经挡在前面了。
  return null;
}

/** 派生节点用的用户名，只是 sing-box 日志里的标识，不参与鉴权。 */
const SINGBOX_USER_NAME = "forwardx";

/**
 * 生成一个 sing-box 入站。
 *
 * 字段名严格按官方入站文档，各协议不通用：Snell 的 psk 在顶层而不是 users 里，
 * Shadowsocks 的 method 与 password 也在顶层，其余协议都是 users 数组。
 */
export function buildSingboxInbound(inbound: ProxyInbound, tag: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: inbound.protocol,
    tag,
    listen: "::",
    listen_port: inbound.port,
  };

  if (inbound.protocol === "vless") {
    base.users = [{ name: SINGBOX_USER_NAME, uuid: inbound.uuid, ...(inbound.flow ? { flow: inbound.flow } : {}) }];
  } else if (inbound.protocol === "vmess") {
    base.users = [{ name: SINGBOX_USER_NAME, uuid: inbound.uuid }];
  } else if (inbound.protocol === "trojan") {
    base.users = [{ name: SINGBOX_USER_NAME, password: inbound.password }];
  } else if (inbound.protocol === "shadowsocks") {
    // 单用户形态：method 与 password 都在顶层，没有 users 数组。
    base.method = inbound.method;
    base.password = inbound.password;
  } else if (inbound.protocol === "hysteria2") {
    base.users = [{ name: SINGBOX_USER_NAME, password: inbound.password }];
    if (inbound.obfs) {
      base.obfs = { type: inbound.obfs, ...(inbound.obfsPassword ? { password: inbound.obfsPassword } : {}) };
    }
    if (inbound.upMbps > 0) base.up_mbps = inbound.upMbps;
    if (inbound.downMbps > 0) base.down_mbps = inbound.downMbps;
  } else if (inbound.protocol === "tuic") {
    base.users = [{ name: SINGBOX_USER_NAME, uuid: inbound.uuid, password: inbound.password }];
    if (inbound.congestionControl) base.congestion_control = inbound.congestionControl;
  } else if (inbound.protocol === "anytls") {
    base.users = [{ name: SINGBOX_USER_NAME, password: inbound.password }];
  } else {
    // Snell：psk 在顶层，版本决定是 obfs_mode 还是 mode。
    base.version = inbound.snellVersion || 4;
    base.psk = inbound.password;
    if (inbound.snellVersion === 6) {
      if (inbound.snellMode) base.mode = inbound.snellMode;
    } else if (inbound.obfs && inbound.obfs !== "none") {
      base.obfs_mode = inbound.obfs;
    }
  }

  const tls = singboxServerTls(inbound);
  if (tls) base.tls = tls;
  const transport = singboxTransport(inbound);
  if (transport) base.transport = transport;
  return base;
}

/** 落地机上一份完整的 sing-box 配置。入站由面板下发，出站固定直连。 */
export function buildSingboxConfig(inbounds: readonly { inbound: ProxyInbound; tag: string }[]): string {
  const config = {
    log: { level: "warn", timestamp: true },
    inbounds: inbounds.map((item) => buildSingboxInbound(item.inbound, item.tag)),
    // 落地机的职责就是把流量放出去，不做分流。
    outbounds: [{ type: "direct", tag: "direct" }],
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

export type ProxyNodeFromInboundOptions = {
  /** 落地机的公网地址。入站自己只知道监听地址（::），不知道对外是哪个 IP。 */
  address: string;
  /** 节点名，留空时用入站的名字。 */
  name?: string;
};

/**
 * 从入站派生出客户端节点。
 *
 * 这是「服务端配置」到「客户端配置」的唯一转换点：私钥留在入站侧，客户端拿到的是
 * 公钥。派生结果直接存进 proxy_nodes，之后中转改写与订阅渲染都走既有那一套。
 */
export function proxyNodeFromInbound(inbound: ProxyInbound, options: ProxyNodeFromInboundOptions): ProxyNode {
  const node = createEmptyProxyNode();
  node.protocol = inbound.protocol as ProxyNodeProtocol;
  node.name = text(options.name) || text(inbound.name);
  node.address = text(options.address);
  node.port = inbound.port;
  node.uuid = inbound.uuid;
  node.password = inbound.password;
  node.method = inbound.method;
  node.flow = inbound.flow;
  node.transport = inbound.transport;
  node.path = inbound.path;
  node.host = inbound.host;
  node.xhttpMode = inbound.xhttpMode;
  node.tls = inbound.security !== "none";
  node.sni = inbound.serverName;
  node.alpn = [...inbound.alpn];
  node.obfs = inbound.obfs;
  node.obfsPassword = inbound.obfsPassword;
  node.congestionControl = inbound.congestionControl;
  node.snellVersion = inbound.snellVersion;
  node.snellMode = inbound.snellMode;
  if (inbound.security === "reality") {
    node.realityPublicKey = inbound.realityPublicKey;
    node.realityShortId = inbound.realityShortId;
    // REALITY 靠 uTLS 伪装成浏览器握手，指纹不填的话客户端行为不一致。
    node.fingerprint = "chrome";
  }
  return node;
}
