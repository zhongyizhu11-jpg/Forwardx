import { and, asc, eq, inArray, sql } from "drizzle-orm";

import {
  forwardRules,
  hosts,
  proxyNodes,
  proxyNodeShares,
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
import { shareProxyNodeRow } from "../../shared/proxyNodeShare";
import { proxyInboundSupportsMultiUser } from "../../shared/proxyInbound";

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
  // 分享记录跟着一起删：留着的话对方订阅里会指向一个不存在的节点 id，
  // 而管理端的「已分享给谁」还照旧显示，看不出人已经拿不到了。
  await db.delete(proxyNodeShares).where(eq(proxyNodeShares.nodeId, id));
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

// ==================== 节点分享 ====================

/**
 * 分享的落点。
 *
 * 派生自「一个端口多份凭据」协议的节点，分享要按**入站**算：给某人分享
 * 不是把自己那份凭据抄给他，而是在那个端口上单独给他开一份。所以这类节点
 * 上的「分享给谁」其实是「这个入站上有谁的凭据」。
 *
 * 粘进来的节点、以及 Shadowsocks / Snell 这种一个端口只有一份 PSK 的，
 * 只能按节点算 —— 分享出去的就是同一份凭据，收回的唯一办法是换掉它，
 * 而那会把已经发出去的配置全部作废。界面上要把这个差别说清楚。
 */
type ProxyNodeShareScope =
  | { kind: "node"; nodeId: number }
  | { kind: "inbound"; nodeId: number; inboundId: number; ownerUserId: number };

async function resolveProxyNodeShareScope(nodeId: number): Promise<ProxyNodeShareScope | null> {
  const node = await getProxyNodeById(nodeId);
  if (!node) return null;
  const inboundId = Number((node as any).inboundId || 0);
  const ownerUserId = Number((node as any).userId || 0);
  if (inboundId <= 0) return { kind: "node", nodeId };
  const { loadProxyInbound } = await import("./proxyInboundRepository");
  const inbound = await loadProxyInbound(inboundId);
  if (!inbound || !proxyInboundSupportsMultiUser(inbound.protocol)) return { kind: "node", nodeId };
  return { kind: "inbound", nodeId, inboundId, ownerUserId };
}

/**
 * 所有「为分享单独发的」凭据行 id。
 *
 * 用来把这类凭据派生出的节点从**主人自己**的订阅里摘掉：它们只为某个租户而
 * 存在，留在主人订阅里就是每多一个租户多一条垃圾节点。
 */
async function getSharedCredentialUserIds(): Promise<Set<number>> {
  const db = await getDb();
  if (!db) return new Set();
  const { proxyInboundUsers } = await import("../../drizzle/schema");
  const rows = await db
    .select({ id: proxyInboundUsers.id })
    .from(proxyInboundUsers)
    .where(sql`${proxyInboundUsers.sharedUserId} > 0`);
  return new Set((rows as any[]).map((row) => Number(row.id)).filter((id) => id > 0));
}

/** 这个入站上，各人各自那份凭据派生出来的节点：收件人 → 节点 id。 */
async function getSharedNodeIdsByInbound(inboundId: number): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  const db = await getDb();
  if (!db) return result;
  const { getProxyInboundUsers } = await import("./proxyInboundRepository");
  const users = await getProxyInboundUsers(inboundId);
  const shared = users.filter((user) => Number(user.sharedUserId || 0) > 0);
  if (shared.length === 0) return result;
  const rows = await db
    .select({ id: proxyNodes.id, inboundUserId: proxyNodes.inboundUserId })
    .from(proxyNodes)
    .where(and(
      eq(proxyNodes.inboundId, inboundId),
      inArray(proxyNodes.inboundUserId, shared.map((user) => Number(user.id))),
    ));
  const nodeByUser = new Map((rows as any[]).map((row) => [Number(row.inboundUserId), Number(row.id)]));
  for (const user of shared) {
    const derived = nodeByUser.get(Number(user.id));
    if (derived) result.set(Number(user.sharedUserId), derived);
  }
  return result;
}

/**
 * 分享给某个用户的节点 id。
 */
export async function getProxyNodeIdsSharedToUser(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ nodeId: proxyNodeShares.nodeId })
    .from(proxyNodeShares)
    .where(eq(proxyNodeShares.userId, Number(userId)));
  return rows.map((row: any) => Number(row.nodeId)).filter((id: number) => id > 0);
}

/**
 * 一批节点各自分享给了谁。一次查完 —— 节点列表要给每一行标「已分享给 N 人」，
 * 逐行查会把一次列表请求变成几十条查询。
 */
export async function getProxyNodeShareUserIds(
  nodeIds: readonly number[],
): Promise<Map<number, number[]>> {
  const result = new Map<number, number[]>();
  const ids = Array.from(new Set(nodeIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  for (const id of ids) result.set(id, []);
  if (ids.length === 0) return result;

  const db = await getDb();
  if (!db) return result;
  const rows = await db
    .select({ nodeId: proxyNodeShares.nodeId, userId: proxyNodeShares.userId })
    .from(proxyNodeShares)
    .where(inArray(proxyNodeShares.nodeId, ids));
  for (const row of rows as any[]) {
    result.get(Number(row.nodeId))?.push(Number(row.userId));
  }
  return result;
}

/**
 * 这个入站上「代表它」的那条节点：主人自己那份凭据派生的。
 *
 * 分享按端口算，但界面上挑的是节点。分享发出去的那些派生节点各自属于某个人，
 * 不能拿来当选项 —— 所以对外一律用这一条代表整个端口。
 */
async function anchorNodeIdForInbound(inboundId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const { getProxyInboundUsers } = await import("./proxyInboundRepository");
  const credentials = await getProxyInboundUsers(inboundId);
  const ownIds = new Set(credentials.filter((user) => !Number(user.sharedUserId || 0)).map((user) => Number(user.id)));
  const rows = await db
    .select({ id: proxyNodes.id, inboundUserId: proxyNodes.inboundUserId })
    .from(proxyNodes)
    .where(eq(proxyNodes.inboundId, inboundId))
    .orderBy(asc(proxyNodes.inboundUserId), asc(proxyNodes.id));
  const own = (rows as any[]).find((row) => ownIds.has(Number(row.inboundUserId || 0)));
  return Number(own?.id || (rows as any[])[0]?.id || 0);
}

/**
 * 管理端「分享给这个人哪些节点」选择框里该勾上哪些。
 *
 * 不能直接用 getProxyNodeIdsSharedToUser：那给的是**他自己那条**派生节点，
 * 而选项列表里放的是代表整个端口的那一条 —— 两边对不上，选择框就会显示成
 * 一个都没选，管理员一保存，他的凭据就被静默收走了。
 */
export async function getProxyNodeShareSelectionForUser(userId: number): Promise<number[]> {
  const ids = await getProxyNodeIdsSharedToUser(userId);
  const result: number[] = [];
  for (const id of ids) {
    const scope = await resolveProxyNodeShareScope(id);
    if (!scope) continue;
    if (scope.kind === "node") {
      result.push(scope.nodeId);
      continue;
    }
    const anchor = await anchorNodeIdForInbound(scope.inboundId);
    if (anchor) result.push(anchor);
  }
  return Array.from(new Set(result));
}

/**
 * 这个人的有效套餐一共带了哪些落地节点。
 *
 * 只算还生效的订阅 —— 到期那一条带的节点不该再算数，否则「到期自动收回」
 * 收完下一次同步又发回去了。
 */
export async function getPlanGrantedProxyNodeIdsForUser(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const { subscriptionPlanProxyNodes, userSubscriptions } = await import("../../drizzle/schema");
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = await db
    .select({ nodeId: subscriptionPlanProxyNodes.nodeId })
    .from(userSubscriptions)
    .innerJoin(subscriptionPlanProxyNodes, eq(subscriptionPlanProxyNodes.planId, userSubscriptions.planId))
    .where(and(
      eq(userSubscriptions.userId, Number(userId)),
      eq(userSubscriptions.status, "active"),
      sql`(${userSubscriptions.expiresAt} IS NULL OR ${userSubscriptions.expiresAt} > ${nowSec})`,
    ));
  return Array.from(new Set((rows as any[]).map((row) => Number(row.nodeId)).filter((id) => id > 0)));
}

/**
 * 把某个人的分享重算一遍，手工的和套餐带的各算各的。
 *
 * 只传其中一路时，另一路沿用库里现有的 —— 套餐同步不能顺手删掉管理员手工
 * 分的，反过来也一样。
 *
 * 凭据的收发跟着这个并集走：并集里还有这个端口就留着，没有了才真收回。
 * 一个端口同时被手工分和套餐带的情况下，撤掉其中一路不该让他断线。
 */
export async function reconcileProxyNodeSharesForUser(
  userId: number,
  input: { manualNodeIds?: readonly number[]; planNodeIds?: readonly number[]; label?: string },
): Promise<{ hostIds: number[] }> {
  const db = await getDb();
  if (!db) return { hostIds: [] };
  const recipient = Number(userId);
  const label = String(input.label || "").trim() || `用户 #${recipient}`;
  const hostIds = new Set<number>();

  const current = await db
    .select({ nodeId: proxyNodeShares.nodeId, source: proxyNodeShares.source })
    .from(proxyNodeShares)
    .where(eq(proxyNodeShares.userId, recipient));
  const keepExisting = (want: "manual" | "plan") => (current as any[])
    .filter((row) => String(row.source || "manual") === want)
    .map((row) => Number(row.nodeId));

  const wanted: Array<{ nodeId: number; source: "manual" | "plan" }> = [];
  for (const nodeId of input.manualNodeIds ?? keepExisting("manual")) {
    wanted.push({ nodeId: Number(nodeId), source: "manual" });
  }
  for (const nodeId of input.planNodeIds ?? keepExisting("plan")) {
    wanted.push({ nodeId: Number(nodeId), source: "plan" });
  }

  const { ensureSharedInboundCredential, releaseSharedInboundCredential } = await import("./proxyInboundRepository");
  const resolved = new Map<number, "manual" | "plan">();
  const keepInboundIds = new Set<number>();
  for (const item of wanted) {
    if (!Number.isInteger(item.nodeId) || item.nodeId <= 0) continue;
    const node = await getProxyNodeById(item.nodeId);
    // 自己的节点不用分享：落进来的话订阅里会出现两份同名节点。
    if (!node || Number((node as any).userId) === recipient) continue;
    const scope = await resolveProxyNodeShareScope(item.nodeId);
    if (!scope) continue;
    let targetNodeId = scope.kind === "node" ? scope.nodeId : 0;
    if (scope.kind === "inbound") {
      keepInboundIds.add(scope.inboundId);
      const provisioned = await ensureSharedInboundCredential(scope.inboundId, recipient, label);
      if (!provisioned) continue;
      hostIds.add(provisioned.hostId);
      targetNodeId = provisioned.nodeId;
    }
    if (!targetNodeId) continue;
    // 手工优先：同一条既手工分了又被套餐带上，记成手工，撤套餐不该把它撤掉。
    if (resolved.get(targetNodeId) !== "manual") resolved.set(targetNodeId, item.source);
  }

  for (const inboundId of await getSharedInboundIdsForUser(recipient)) {
    if (keepInboundIds.has(inboundId)) continue;
    const released = await releaseSharedInboundCredential(inboundId, recipient);
    if (released) {
      const hostId = await getInboundHostId(inboundId);
      if (hostId) hostIds.add(hostId);
    }
  }

  await db.delete(proxyNodeShares).where(eq(proxyNodeShares.userId, recipient));
  const values = Array.from(resolved.entries()).map(([nodeId, source]) => ({ nodeId, userId: recipient, source }));
  if (values.length > 0) await db.insert(proxyNodeShares).values(values as any);
  return { hostIds: Array.from(hostIds).filter((hostId) => hostId > 0) };
}

/**
 * 套餐带的节点重算一遍：买了自动发，到期 / 换套餐 / 被停用自动收。
 *
 * allowed = false 时一律收回。订阅地址那边到期就拉不动了，可手上那份凭据是
 * 落在落地机上的 —— 不主动收，它照连不误。
 */
export async function syncPlanProxyNodeSharesForUser(
  userId: number,
  label?: string,
  options: { allowed?: boolean } = {},
): Promise<{ hostIds: number[] }> {
  const allowed = options.allowed !== false;
  const planNodeIds = allowed ? await getPlanGrantedProxyNodeIdsForUser(userId) : [];
  return reconcileProxyNodeSharesForUser(userId, { planNodeIds, label });
}

/**
 * 设定「这个用户能拿到哪些节点」（全量替换），和主机权限那套一个路数。
 *
 * 自己的节点不用分享，落进来的话对方订阅里会出现两份同名节点，客户端里就是
 * 两条一模一样的线路 —— 这里直接滤掉。
 */
export async function setProxyNodeSharesForUser(
  userId: number,
  nodeIds: readonly number[],
  options: { label?: string } = {},
): Promise<{ hostIds: number[] }> {
  // 手工那一路走同一个对账函数，套餐带的那些原样留着。
  return reconcileProxyNodeSharesForUser(userId, { manualNodeIds: nodeIds, label: options.label });
}

/** 这个人在哪些入站上有单独发的凭据。 */
async function getSharedInboundIdsForUser(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const { proxyInboundUsers } = await import("../../drizzle/schema");
  const rows = await db
    .select({ inboundId: proxyInboundUsers.inboundId })
    .from(proxyInboundUsers)
    .where(eq(proxyInboundUsers.sharedUserId, Number(userId)));
  return Array.from(new Set((rows as any[]).map((row) => Number(row.inboundId)).filter((id) => id > 0)));
}

async function getInboundHostId(inboundId: number): Promise<number> {
  const { getProxyInboundById } = await import("./proxyInboundRepository");
  const row = await getProxyInboundById(inboundId);
  return Number((row as any)?.hostId || 0);
}

/**
 * 可供分享的节点清单（管理端选人用）。
 *
 * 只取选择框要显示的几列 —— 这个接口是给管理员挑节点的，凭据没有任何理由
 * 跟着列表一起发出去。
 */
export async function getProxyNodeShareOptions() {
  const db = await getDb();
  if (!db) return [];
  /**
   * 为分享单独发出去的那些凭据不进清单：它们已经是某个人的了，再拿去分享给
   * 第二个人，等于两个人共用一份凭据，取消其中一个就把另一个也断了。要给第
   * 二个人，挑原来那条节点即可 —— 系统会另发一份。
   */
  const excludedSet = await getSharedCredentialUserIds();
  const rows = await db
    .select({
      id: proxyNodes.id,
      userId: proxyNodes.userId,
      name: proxyNodes.name,
      protocol: proxyNodes.protocol,
      address: proxyNodes.address,
      port: proxyNodes.port,
      inboundId: proxyNodes.inboundId,
      isEnabled: proxyNodes.isEnabled,
      inboundUserId: proxyNodes.inboundUserId,
    })
    .from(proxyNodes)
    .orderBy(asc(proxyNodes.sortOrder), asc(proxyNodes.id));
  if (excludedSet.size === 0) return rows;
  return (rows as any[]).filter((row) => !excludedSet.has(Number(row.inboundUserId || 0)));
}

/**
 * 设定「这个节点分享给了谁」（全量替换）。
 *
 * 和 setProxyNodeSharesForUser 是同一件事的两个入口：那个从用户出发挑节点，
 * 这个从节点出发挑人。站在节点这边想把它租出去时，绕到用户页去一个个找人
 * 是件很别扭的事。
 */
export async function setProxyNodeShareUsers(
  nodeId: number,
  userIds: readonly number[],
  options: { labels?: ReadonlyMap<number, string> } = {},
): Promise<{ hostIds: number[] }> {
  const db = await getDb();
  if (!db) return { hostIds: [] };
  const id = Number(nodeId);
  if (!Number.isInteger(id) || id <= 0) return { hostIds: [] };
  const scope = await resolveProxyNodeShareScope(id);
  if (!scope) return { hostIds: [] };

  const node = await getProxyNodeById(id);
  if (!node) return { hostIds: [] };
  const wanted = Array.from(new Set(userIds.map((value) => Number(value))))
    .filter((value) => Number.isInteger(value) && value > 0 && value !== Number((node as any).userId));

  if (scope.kind === "node") {
    await db.delete(proxyNodeShares).where(eq(proxyNodeShares.nodeId, id));
    if (wanted.length > 0) {
      await db.insert(proxyNodeShares).values(wanted.map((userId) => ({ nodeId: id, userId })) as any);
    }
    return { hostIds: [] };
  }

  /**
   * 多凭据入站：这里管的是「这个端口上有谁的凭据」，一人一份，各自派生一条
   * 节点。所以要按人增删凭据，而不是把当前这条节点的分享名单改一改。
   */
  const { ensureSharedInboundCredential, releaseSharedInboundCredential } = await import("./proxyInboundRepository");
  const hostIds = new Set<number>();
  const current = await getSharedNodeIdsByInbound(scope.inboundId);
  const target = new Set(wanted);

  for (const [recipient, sharedNodeId] of current) {
    if (target.has(recipient)) continue;
    await db.delete(proxyNodeShares).where(eq(proxyNodeShares.nodeId, sharedNodeId));
    const released = await releaseSharedInboundCredential(scope.inboundId, recipient);
    if (released) hostIds.add(await getInboundHostId(scope.inboundId));
  }

  for (const recipient of target) {
    const label = options.labels?.get(recipient) || `用户 #${recipient}`;
    const provisioned = await ensureSharedInboundCredential(scope.inboundId, recipient, label);
    if (!provisioned) continue;
    hostIds.add(provisioned.hostId);
    // 幂等：同一个人再点一次保存，不该多出一条分享记录。
    await db
      .delete(proxyNodeShares)
      .where(and(eq(proxyNodeShares.nodeId, provisioned.nodeId), eq(proxyNodeShares.userId, recipient)));
    await db.insert(proxyNodeShares).values([{ nodeId: provisioned.nodeId, userId: recipient }] as any);
  }

  /**
   * 这条节点本身上的分享记录一律清掉：多凭据入站上，任何人都该拿自己那份，
   * 而不是主人这一份。老版本留下的记录也在这里被顺手纠正。
   */
  await db.delete(proxyNodeShares).where(eq(proxyNodeShares.nodeId, id));
  return { hostIds: Array.from(hostIds).filter((hostId) => hostId > 0) };
}

/**
 * 节点被分享给的那些人。管理端展示用。
 *
 * 多凭据入站上，各人拿的是自己那条派生节点，所以要问的是「这个入站上有谁的
 * 凭据」——只查当前这条节点的分享记录会永远返回空，界面上就成了「谁都没分享」。
 */
export async function getProxyNodeShareRecipients(nodeId: number): Promise<number[]> {
  const scope = await resolveProxyNodeShareScope(Number(nodeId));
  if (scope?.kind === "inbound") {
    return Array.from((await getSharedNodeIdsByInbound(scope.inboundId)).keys());
  }
  const map = await getProxyNodeShareUserIds([Number(nodeId)]);
  return map.get(Number(nodeId)) || [];
}

/** 分享到某个用户名下的节点行（原样，未做分享改写）。 */
export async function getProxyNodesSharedToUser(userId: number) {
  const ids = await getProxyNodeIdsSharedToUser(userId);
  if (ids.length === 0) return [];
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(proxyNodes)
    .where(and(inArray(proxyNodes.id, ids), eq(proxyNodes.isEnabled, true)))
    .orderBy(asc(proxyNodes.sortOrder), asc(proxyNodes.id));
}

/**
 * 订阅要用的节点：自己的，加上别人分享给我的。
 *
 * 订阅组装的每一处都得走这个函数，不能有的地方用 getProxyNodesByUser ——
 * 计划和文档两次取的模板集合一旦不一致，订阅里会出现「有节点名没节点」
 * 或者策略组指向不存在的节点这种坏配置。
 */
export async function getProxyNodesForSubscription(userId: number) {
  const [owned, shared, sharedCredentialIds] = await Promise.all([
    getProxyNodesByUser(userId),
    getProxyNodesSharedToUser(userId),
    getSharedCredentialUserIds(),
  ]);
  /**
   * 为别人单独发的凭据不进主人自己的订阅。
   *
   * 那条节点归属确实是主人（凭据长在他的端口上），但它只为某个租户而存在 ——
   * 留着的话，主人的客户端里每多一个租户就多一条一模一样、只有凭据不同的
   * 线路，十个租户就是十条垃圾。
   */
  const own = sharedCredentialIds.size === 0
    ? owned
    : (owned as any[]).filter((row) => !sharedCredentialIds.has(Number(row.inboundUserId || 0)));
  return [...own, ...shared.map((row: any) => shareProxyNodeRow(row))];
}

// ==================== 落地机的套餐用量 ====================

/**
 * 给一批落地节点累加已用流量。
 *
 * 为什么要单独存一列而不是查 traffic_stats 求和：那张表只保留 72 小时，
 * 过期行会被清掉。要显示「这个月用了 367G」就必须有一个不会被清的累计值。
 *
 * 口径要说清：这里只累加**经过面板转发规则**的流量。订阅里的「直连」条目是
 * 客户端直连落地机的，中转机不在路径上，面板看不见；这台机器上跑的别的服务
 * 同理。所以这个数只会小于等于机房账单，需要对齐时用 setProxyNodeTrafficUsed
 * 手工校准。
 */
export async function addProxyNodeTraffic(entries: ReadonlyMap<number, number>) {
  if (entries.size === 0) return;
  const db = await getDb();
  if (!db) return;
  for (const [nodeId, bytes] of entries) {
    const id = Number(nodeId);
    const delta = Number(bytes);
    if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(delta) || delta <= 0) continue;
    await db.update(proxyNodes).set({
      trafficUsed: sql`${proxyNodes.trafficUsed} + ${delta}`,
      updatedAt: nowDate(),
    }).where(eq(proxyNodes.id, id));
  }
}

/** 手工校准已用量，用来跟机房的账单对齐。之后仍然继续累加。 */
export async function setProxyNodeTrafficUsed(id: number, bytes: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(proxyNodes).set({
    trafficUsed: Math.max(0, Math.floor(Number(bytes) || 0)),
    updatedAt: nowDate(),
  }).where(eq(proxyNodes.id, Number(id)));
}

/** 用量清零，并记下这次重置的时间（月度自动重置靠它判断本周期是否已经重置过）。 */
export async function resetProxyNodeTraffic(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(proxyNodes).set({
    trafficUsed: 0,
    lastTrafficReset: nowDate(),
    updatedAt: nowDate(),
  }).where(eq(proxyNodes.id, Number(id)));
}

/**
 * 该做月度重置的节点。
 *
 * 只挑「开了自动重置、且今天已经到了重置日」的，重复触发由 lastTrafficReset
 * 挡住 —— 调度任务每小时跑一次，不挡的话一天会清零二十几次。
 */
export async function getProxyNodesForTrafficAutoReset(reference = nowDate()) {
  const db = await getDb();
  if (!db) return [];
  const day = reference.getDate();
  return db
    .select()
    .from(proxyNodes)
    .where(and(
      eq(proxyNodes.trafficAutoReset, true),
      // 28 号之后把 29/30/31 号设的也一起带上：那几天在二月不存在，
      // 不带的话二月整月不会重置。
      sql`${proxyNodes.trafficResetDay} <= ${day}`,
    ));
}

// ==================== 客户端订阅：令牌 ====================

/** 某个用户有几条订阅地址。配额检查用。 */
export async function countProxySubTokensByUser(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({ id: proxySubTokens.id })
    .from(proxySubTokens)
    .where(eq(proxySubTokens.userId, Number(userId)));
  return rows.length;
}

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

/**
 * 订阅令牌的长度。地址里带着全部节点凭据，短了能被猜到。
 * 自动开的那条和手工建的那条必须一样长 —— 两处各写一个数字迟早会分叉。
 */
export const PROXY_SUB_TOKEN_LENGTH = 40;

/**
 * 没有订阅地址就自动开一条。
 *
 * 「买了套餐 → 进面板 → 还得自己点一下新建链接 → 才拿得到地址」，中间这一步
 * 对用户没有任何意义：他要的就是那条地址。开通即可用，才叫开通。
 *
 * 已经有地址（哪怕是停用的）就不动，免得他删掉之后又被自动加回来。
 */
export async function ensureDefaultProxySubToken(
  userId: number,
  name = "默认订阅",
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const existing = await countProxySubTokensByUser(userId);
  if (existing > 0) return 0;
  const { nanoid } = await import("nanoid");
  return Number(await insertAndGetId("proxy_sub_tokens", {
    userId,
    name,
    token: nanoid(PROXY_SUB_TOKEN_LENGTH),
    defaultFormat: "base64",
    rulePreset: "balanced",
  } as any));
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

  const templates = await getProxyNodesForSubscription(userId);
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
  const templates = await getProxyNodesForSubscription(userId);
  return buildProxySubscriptionDocument(plan, templates as any, {
    mainGroupName: PROXY_SUBSCRIPTION_GROUP_NAME,
    rulePreset: normalizeProxyRulePreset(options.rulePreset),
  });
}
