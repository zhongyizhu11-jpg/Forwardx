/**
 * 把「转发规则 + 节点模板 + 入口主机」组装成订阅里的节点列表。
 *
 * 放在 shared 是为了让面板能预览出和服务端完全一致的结果：用户在界面上看到的
 * 「这些节点会进订阅」必须就是客户端真正拉到的那一份，否则排查问题时无从对账。
 *
 * 这里只做纯计算，不碰数据库；调用方负责把行取出来传进来。
 */

import { getHostEntryAddress, type HostEntryAddressSource } from "./hostEntryAddress";
import {
  createEmptyProxyNode,
  relayProxyNode,
  type ProxyNode,
  type ProxyNodeProtocol,
  type ProxyNodeTransport,
} from "./proxyNode";

/** proxy_nodes 表的一行，字段名与数据库一致。 */
export type ProxyNodeTemplateRow = {
  id: number;
  name?: unknown;
  protocol?: unknown;
  address?: unknown;
  port?: unknown;
  uuid?: unknown;
  password?: unknown;
  method?: unknown;
  alterId?: unknown;
  flow?: unknown;
  transport?: unknown;
  path?: unknown;
  host?: unknown;
  tls?: unknown;
  sni?: unknown;
  alpn?: unknown;
  fingerprint?: unknown;
  allowInsecure?: unknown;
  realityPublicKey?: unknown;
  realityShortId?: unknown;
  udp?: unknown;
  isEnabled?: unknown;
};

/** forward_rules 表里订阅需要用到的字段。 */
export type ProxySubscriptionRuleRow = {
  id: number;
  hostId?: unknown;
  name?: unknown;
  sourcePort?: unknown;
  proxyNodeId?: unknown;
  proxyNodeVisible?: unknown;
  proxyNodeName?: unknown;
  isEnabled?: unknown;
  pendingDelete?: unknown;
};

export type ProxySubscriptionHostRow = HostEntryAddressSource & {
  id: number;
  name?: unknown;
};

/** 一条转发没能进订阅的原因，用于在界面上解释而不是让节点无声消失。 */
export type ProxySubscriptionSkipReason =
  | "unbound"
  | "hidden"
  | "template-disabled"
  | "rule-disabled"
  | "no-entry-address";

export const PROXY_SUBSCRIPTION_SKIP_LABELS: Record<ProxySubscriptionSkipReason, string> = {
  unbound: "未绑定客户端节点",
  hidden: "已在订阅中隐藏",
  "template-disabled": "所属节点模板已停用",
  "rule-disabled": "转发已停用",
  "no-entry-address": "入口主机没有可用地址",
};

export type ProxySubscriptionEntry = {
  ruleId: number;
  templateId: number;
  node: ProxyNode;
};

export type ProxySubscriptionSkip = {
  ruleId: number;
  ruleName: string;
  reason: ProxySubscriptionSkipReason;
};

export type ProxySubscriptionPlan = {
  entries: ProxySubscriptionEntry[];
  skipped: ProxySubscriptionSkip[];
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function bool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const raw = text(value).toLowerCase();
  return raw === "1" || raw === "true";
}

function toPort(value: unknown): number {
  const port = Number(text(value));
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

const PROTOCOLS = new Set<ProxyNodeProtocol>(["vless", "vmess", "trojan", "shadowsocks"]);
const TRANSPORTS = new Set<ProxyNodeTransport>(["tcp", "ws", "grpc", "http"]);

/** 把数据库行还原成节点模型。列都是宽松类型，这里统一收敛。 */
export function proxyNodeFromTemplateRow(row: ProxyNodeTemplateRow): ProxyNode {
  const node = createEmptyProxyNode();
  const protocol = text(row.protocol).toLowerCase() as ProxyNodeProtocol;
  node.protocol = PROTOCOLS.has(protocol) ? protocol : "vless";
  node.name = text(row.name);
  node.address = text(row.address);
  node.port = toPort(row.port);
  node.uuid = text(row.uuid);
  node.password = text(row.password);
  node.method = text(row.method);
  node.alterId = Number(text(row.alterId)) || 0;
  node.flow = text(row.flow);
  const transport = text(row.transport).toLowerCase() as ProxyNodeTransport;
  node.transport = TRANSPORTS.has(transport) ? transport : "tcp";
  node.path = text(row.path);
  node.host = text(row.host);
  node.tls = bool(row.tls);
  node.sni = text(row.sni);
  node.alpn = text(row.alpn).split(",").map((item) => item.trim()).filter(Boolean);
  node.fingerprint = text(row.fingerprint);
  node.allowInsecure = bool(row.allowInsecure);
  node.realityPublicKey = text(row.realityPublicKey);
  node.realityShortId = text(row.realityShortId);
  node.udp = row.udp === undefined ? true : bool(row.udp);
  return node;
}

/** 订阅里显示的节点名：优先用户自定义，否则「入口主机 → 模板名」。 */
export function defaultProxySubscriptionNodeName(options: {
  hostName: string;
  templateName: string;
  ruleName: string;
}): string {
  const host = text(options.hostName);
  const template = text(options.templateName);
  if (host && template) return `${host} → ${template}`;
  return template || host || text(options.ruleName) || "节点";
}

export type BuildProxySubscriptionPlanInput = {
  rules: readonly ProxySubscriptionRuleRow[];
  templates: readonly ProxyNodeTemplateRow[];
  hosts: readonly ProxySubscriptionHostRow[];
};

/**
 * 生成订阅节点列表。
 *
 * 停用的转发会被排除：它此刻并不监听，放进订阅只会给客户端一个连不上的节点。
 * 但不看 isRunning，因为那是瞬时状态，据此增删会让订阅内容来回抖动。
 */
export function buildProxySubscriptionPlan(input: BuildProxySubscriptionPlanInput): ProxySubscriptionPlan {
  const templatesById = new Map<number, ProxyNodeTemplateRow>();
  for (const template of input.templates) templatesById.set(Number(template.id), template);
  const hostsById = new Map<number, ProxySubscriptionHostRow>();
  for (const host of input.hosts) hostsById.set(Number(host.id), host);

  const entries: ProxySubscriptionEntry[] = [];
  const skipped: ProxySubscriptionSkip[] = [];

  for (const rule of input.rules) {
    const ruleId = Number(rule.id);
    const ruleName = text(rule.name) || `规则 #${ruleId}`;
    const skip = (reason: ProxySubscriptionSkipReason) => skipped.push({ ruleId, ruleName, reason });

    if (bool(rule.pendingDelete)) continue;

    const templateId = Number(rule.proxyNodeId || 0);
    if (!templateId) {
      skip("unbound");
      continue;
    }
    if (rule.proxyNodeVisible !== undefined && !bool(rule.proxyNodeVisible)) {
      skip("hidden");
      continue;
    }
    if (rule.isEnabled !== undefined && !bool(rule.isEnabled)) {
      skip("rule-disabled");
      continue;
    }

    const template = templatesById.get(templateId);
    if (!template) {
      skip("unbound");
      continue;
    }
    if (template.isEnabled !== undefined && !bool(template.isEnabled)) {
      skip("template-disabled");
      continue;
    }

    const host = hostsById.get(Number(rule.hostId || 0));
    const address = getHostEntryAddress(host);
    const port = toPort(rule.sourcePort);
    if (!address || !port) {
      skip("no-entry-address");
      continue;
    }

    const templateNode = proxyNodeFromTemplateRow(template);
    const name = text(rule.proxyNodeName) || defaultProxySubscriptionNodeName({
      hostName: text(host?.name),
      templateName: templateNode.name,
      ruleName,
    });

    entries.push({
      ruleId,
      templateId,
      node: relayProxyNode(templateNode, { address, port, name }),
    });
  }

  return { entries, skipped };
}

/**
 * 同名节点会让 Clash 的 proxy-groups 引用产生歧义，客户端表现是随机少几个节点。
 * 重复时追加序号，保证名称在一份订阅里唯一。
 */
export function dedupeProxyNodeNames(nodes: readonly ProxyNode[]): ProxyNode[] {
  const used = new Map<string, number>();
  return nodes.map((node) => {
    const base = text(node.name) || "节点";
    const seen = used.get(base) || 0;
    used.set(base, seen + 1);
    if (seen === 0) return node.name === base ? node : { ...node, name: base };
    return { ...node, name: `${base} #${seen + 1}` };
  });
}
