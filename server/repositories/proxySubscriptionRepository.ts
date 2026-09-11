import { and, asc, eq, inArray } from "drizzle-orm";

import {
  forwardRules,
  hosts,
  proxyNodes,
  proxySubTokens,
  type InsertProxyNode,
  type InsertProxySubToken,
} from "../../drizzle/schema";
import { getDb, insertAndGetId, nowDate } from "../dbRuntime";
import {
  buildProxySubscriptionDocument,
  buildProxySubscriptionPlan,
  type ProxySubscriptionDocument,
  type ProxySubscriptionPlan,
} from "../../shared/proxySubscriptionPlan";
import { PROXY_SUBSCRIPTION_GROUP_NAME } from "../../shared/proxySubscription";
import { normalizeProxyRulePreset } from "../../shared/proxyRuleset";

// ==================== 客户端订阅：节点模板 ====================

export async function getProxyNodesByUser(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(proxyNodes)
    .where(eq(proxyNodes.userId, userId))
    .orderBy(asc(proxyNodes.sortOrder), asc(proxyNodes.id));
}

export async function getProxyNodeById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(proxyNodes).where(eq(proxyNodes.id, id)).limit(1);
  return rows[0];
}

export async function createProxyNode(data: InsertProxyNode) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return insertAndGetId("proxy_nodes", data as any);
}

export async function updateProxyNode(id: number, data: Partial<InsertProxyNode>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(proxyNodes).set({ ...data, updatedAt: nowDate() } as any).where(eq(proxyNodes.id, id));
}

/**
 * 删除模板前先解绑引用它的转发，否则这些规则会留着一个指向不存在模板的
 * proxyNodeId，订阅里静默少节点且界面上看不出原因。
 */
export async function deleteProxyNode(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(forwardRules)
    .set({ proxyNodeId: null, updatedAt: nowDate() } as any)
    .where(eq(forwardRules.proxyNodeId, id));
  await db.delete(proxyNodes).where(eq(proxyNodes.id, id));
}

export async function countRulesUsingProxyNode(id: number) {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({ id: forwardRules.id })
    .from(forwardRules)
    .where(and(eq(forwardRules.proxyNodeId, id), eq(forwardRules.pendingDelete, false)));
  return rows.length;
}

/**
 * 一批节点各自被哪些转发绑定。
 *
 * 一次查完而不是每个节点查一遍：节点多起来之后，逐个 count 会把一次列表请求
 * 变成几十条查询。调用方拿到规则 id 之后还要用它去汇总流量和探测结果，
 * 所以这里返回 id 而不只是个数。
 */
export async function getRuleIdsUsingProxyNodes(
  nodeIds: readonly number[],
): Promise<Map<number, number[]>> {
  const result = new Map<number, number[]>();
  const ids = Array.from(new Set(nodeIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  for (const id of ids) result.set(id, []);
  if (ids.length === 0) return result;

  const db = await getDb();
  if (!db) return result;
  const rows = await db
    .select({ id: forwardRules.id, proxyNodeId: forwardRules.proxyNodeId })
    .from(forwardRules)
    .where(and(inArray(forwardRules.proxyNodeId, ids), eq(forwardRules.pendingDelete, false)));

  for (const row of rows as any[]) {
    const nodeId = Number(row.proxyNodeId || 0);
    const list = result.get(nodeId);
    if (list) list.push(Number(row.id));
  }
  return result;
}

// ==================== 客户端订阅：令牌 ====================

export async function getProxySubTokensByUser(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(proxySubTokens)
    .where(eq(proxySubTokens.userId, userId))
    .orderBy(asc(proxySubTokens.id));
}

export async function getProxySubTokenById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(proxySubTokens).where(eq(proxySubTokens.id, id)).limit(1);
  return rows[0];
}

export async function getProxySubTokenByToken(token: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(proxySubTokens).where(eq(proxySubTokens.token, token)).limit(1);
  return rows[0];
}

export async function createProxySubToken(data: InsertProxySubToken) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return insertAndGetId("proxy_sub_tokens", data as any);
}

export async function updateProxySubToken(id: number, data: Partial<InsertProxySubToken>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(proxySubTokens).set({ ...data, updatedAt: nowDate() } as any).where(eq(proxySubTokens.id, id));
}

export async function deleteProxySubToken(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(proxySubTokens).where(eq(proxySubTokens.id, id));
}

/**
 * 记录一次订阅拉取。失败不应该影响订阅内容的返回，所以调用方按尽力而为处理。
 */
export async function recordProxySubTokenAccess(id: number, info: { ip?: string; userAgent?: string }) {
  const db = await getDb();
  if (!db) return;
  const current = await getProxySubTokenById(id);
  await db
    .update(proxySubTokens)
    .set({
      accessCount: Number(current?.accessCount || 0) + 1,
      lastAccessAt: nowDate(),
      lastAccessIp: (info.ip || "").slice(0, 64) || null,
      lastAccessUserAgent: (info.userAgent || "").slice(0, 200) || null,
      updatedAt: nowDate(),
    } as any)
    .where(eq(proxySubTokens.id, id));
}

// ==================== 组装订阅 ====================

/**
 * 取出该用户的转发、模板与入口主机，算出订阅节点列表。
 *
 * 主机不按 userId 过滤：转发可以建在共享主机上，那台主机未必属于这个用户，
 * 但入口地址仍然是它的。规则本身已按 userId 限定，不会越权。
 */
export async function buildProxySubscriptionPlanForUser(userId: number): Promise<ProxySubscriptionPlan> {
  const db = await getDb();
  if (!db) return { entries: [], skipped: [] };

  const rules = await db
    .select({
      id: forwardRules.id,
      hostId: forwardRules.hostId,
      name: forwardRules.name,
      sourcePort: forwardRules.sourcePort,
      // QUIC 系节点绑到只放行 TCP 的转发上会静默连不上，订阅组装时要据此排除。
      protocol: forwardRules.protocol,
      proxyNodeId: forwardRules.proxyNodeId,
      proxyNodeVisible: forwardRules.proxyNodeVisible,
      proxyNodeName: forwardRules.proxyNodeName,
      isEnabled: forwardRules.isEnabled,
      pendingDelete: forwardRules.pendingDelete,
      sortOrder: forwardRules.sortOrder,
    })
    .from(forwardRules)
    .where(and(eq(forwardRules.userId, userId), eq(forwardRules.pendingDelete, false)))
    .orderBy(asc(forwardRules.sortOrder), asc(forwardRules.id));

  const templates = await getProxyNodesByUser(userId);
  const hostRows = await db
    .select({
      id: hosts.id,
      name: hosts.name,
      ip: hosts.ip,
      ipv4: hosts.ipv4,
      ipv6: hosts.ipv6,
      entryIp: hosts.entryIp,
      ddnsEnabled: hosts.ddnsEnabled,
      ddnsDomain: hosts.ddnsDomain,
    })
    .from(hosts);

  return buildProxySubscriptionPlan({
    rules: rules as any,
    templates: templates as any,
    hosts: hostRows as any,
  });
}

/**
 * 订阅实际要渲染的内容：去重后的节点、策略组、分流规则。
 *
 * 规则预设按订阅链接（即按设备）算，不同设备可以要不同的分流。
 */
export async function getProxySubscriptionDocumentForUser(
  userId: number,
  options: { rulePreset?: unknown } = {},
): Promise<ProxySubscriptionDocument> {
  const plan = await buildProxySubscriptionPlanForUser(userId);
  const templates = await getProxyNodesByUser(userId);
  return buildProxySubscriptionDocument(plan, templates as any, {
    mainGroupName: PROXY_SUBSCRIPTION_GROUP_NAME,
    rulePreset: normalizeProxyRulePreset(options.rulePreset),
  });
}
