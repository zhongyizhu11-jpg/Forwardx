/**
 * 落地入站的读写，以及「入站 → 派生节点」的同步。
 *
 * 派生这一步是整条链路的接缝：入站存的是「落地机怎么听」，派生出来的
 * proxy_nodes 行是「客户端怎么连」。订阅那一整套（中转改写、前置代理、六种
 * 渲染器）只认后者，所以入站每次保存都要把派生结果整行覆盖过去。
 *
 * 覆盖而不是增量合并：入站是唯一真相，派生节点上任何手工改动都会在下次保存时
 * 消失 —— 与其让两边悄悄分叉，不如让它明确地不可编辑（inboundId 非 0 即为派生）。
 */

import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  hosts,
  proxyInbounds,
  proxyInboundUsers,
  proxyNodes,
  users,
  type InsertProxyInbound,
  type InsertProxyInboundUser,
} from "../../drizzle/schema";
import { getDb, insertAndGetId, nowDate } from "../dbRuntime";
import { getHostEntryAddress } from "../../shared/hostEntryAddress";
import {
  createEmptyProxyInbound,
  createEmptyProxyInboundUser,
  proxyInboundSupportsMultiUser,
  proxyInboundUserCredentialKinds,
  proxyNodesFromInbound,
  type ProxyInbound,
  type ProxyInboundUser,
} from "../../shared/proxyInbound";
import { PROXY_NODE_TRANSPORTS, type ProxyNodeTransport } from "../../shared/proxyNode";

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function num(value: unknown): number {
  const parsed = Number(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 把数据库行还原成入站模型。列都是宽松类型，这里统一收敛。 */
export function proxyInboundFromRow(row: Record<string, unknown>): ProxyInbound {
  const inbound = createEmptyProxyInbound();
  inbound.protocol = text(row.protocol).toLowerCase() as ProxyInbound["protocol"];
  inbound.name = text(row.name);
  inbound.port = num(row.port);
  const transport = text(row.transport).toLowerCase() as ProxyNodeTransport;
  inbound.transport = (PROXY_NODE_TRANSPORTS as readonly string[]).includes(transport) ? transport : "tcp";
  inbound.security = text(row.security).toLowerCase() as ProxyInbound["security"];
  inbound.uuid = text(row.uuid);
  inbound.password = text(row.password);
  inbound.method = text(row.method);
  inbound.flow = text(row.flow);
  inbound.path = text(row.path);
  inbound.host = text(row.host);
  inbound.xhttpMode = text(row.xhttpMode);
  inbound.serverName = text(row.serverName);
  inbound.alpn = text(row.alpn).split(",").map((item) => item.trim()).filter(Boolean);
  inbound.certPath = text(row.certPath);
  inbound.keyPath = text(row.keyPath);
  inbound.acmeEmail = text(row.acmeEmail);
  inbound.realityPrivateKey = text(row.realityPrivateKey);
  inbound.realityPublicKey = text(row.realityPublicKey);
  inbound.realityShortId = text(row.realityShortId);
  inbound.realityDest = text(row.realityDest);
  inbound.obfs = text(row.obfs).toLowerCase();
  inbound.obfsPassword = text(row.obfsPassword);
  inbound.upMbps = num(row.upMbps);
  inbound.downMbps = num(row.downMbps);
  inbound.congestionControl = text(row.congestionControl);
  inbound.snellVersion = num(row.snellVersion);
  inbound.snellMode = text(row.snellMode);
  return inbound;
}

/** 把入站模型摊平成数据库列。与 proxyInboundFromRow 是一对，改一边要改另一边。 */
export function proxyInboundToRow(inbound: ProxyInbound): Partial<InsertProxyInbound> {
  return {
    protocol: inbound.protocol,
    port: inbound.port,
    transport: inbound.transport,
    security: inbound.security,
    uuid: inbound.uuid || null,
    password: inbound.password || null,
    method: inbound.method || null,
    flow: inbound.flow || null,
    path: inbound.path || null,
    host: inbound.host || null,
    xhttpMode: inbound.xhttpMode || null,
    serverName: inbound.serverName || null,
    alpn: inbound.alpn.length ? inbound.alpn.join(",") : null,
    certPath: inbound.certPath || null,
    keyPath: inbound.keyPath || null,
    acmeEmail: inbound.acmeEmail || null,
    realityPrivateKey: inbound.realityPrivateKey || null,
    realityPublicKey: inbound.realityPublicKey || null,
    realityShortId: inbound.realityShortId || null,
    realityDest: inbound.realityDest || null,
    obfs: inbound.obfs || null,
    obfsPassword: inbound.obfsPassword || null,
    upMbps: inbound.upMbps,
    downMbps: inbound.downMbps,
    congestionControl: inbound.congestionControl || null,
    snellVersion: inbound.snellVersion,
    snellMode: inbound.snellMode || null,
  } as Partial<InsertProxyInbound>;
}

// ==================== 读 ====================

/** 某个用户名下有几个自建落地节点。配额检查用。 */
export async function countProxyInboundsByUser(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({ id: proxyInbounds.id })
    .from(proxyInbounds)
    .where(eq(proxyInbounds.userId, Number(userId)));
  return rows.length;
}

export async function getProxyInboundsByUser(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(proxyInbounds)
    .where(eq(proxyInbounds.userId, userId))
    .orderBy(asc(proxyInbounds.sortOrder), asc(proxyInbounds.id));
}

/**
 * 全部入站。只给管理员用 —— 把一台机器上的多个端口分租给不同用户时，
 * 管理员要能看到全量，否则只看得见自己名下那几个。
 */
export async function getAllProxyInbounds() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(proxyInbounds)
    .orderBy(asc(proxyInbounds.hostId), asc(proxyInbounds.sortOrder), asc(proxyInbounds.id));
}

/** 连用户一起读出来的入站模型。生成配置与派生节点都要用这个，而不是只读行。 */
export async function loadProxyInbound(id: number): Promise<ProxyInbound | null> {
  const row = await getProxyInboundById(id);
  if (!row) return null;
  const inbound = proxyInboundFromRow(row as any);
  inbound.users = proxyInboundSupportsMultiUser(inbound.protocol) ? await getProxyInboundUsers(id) : [];
  return inbound;
}

export async function getProxyInboundById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(proxyInbounds).where(eq(proxyInbounds.id, id)).limit(1);
  return rows[0];
}

/** 一台主机上启用中的入站，用来生成它的 sing-box 配置。 */
export async function getEnabledProxyInboundsByHost(hostId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(proxyInbounds)
    .where(and(eq(proxyInbounds.hostId, hostId), eq(proxyInbounds.isEnabled, true)))
    .orderBy(asc(proxyInbounds.sortOrder), asc(proxyInbounds.id));
}

/**
 * 这个端口在这台主机上被别的入站占了吗？
 *
 * 端口撞车的后果不是「新的这个起不来」，而是 sing-box 拒绝加载整份配置 ——
 * 同一台机器上其他入站会跟着一起停。所以要在保存前就挡住。
 */
export async function findProxyInboundPortConflict(hostId: number, port: number, exceptId = 0) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select()
    .from(proxyInbounds)
    .where(and(eq(proxyInbounds.hostId, hostId), eq(proxyInbounds.port, port)));
  return rows.find((row: any) => Number(row.id) !== Number(exceptId));
}

// ==================== 写 ====================

export async function createProxyInbound(data: InsertProxyInbound) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return insertAndGetId("proxy_inbounds", data as any);
}

export async function updateProxyInbound(id: number, data: Partial<InsertProxyInbound>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(proxyInbounds).set({ ...data, updatedAt: nowDate() } as any).where(eq(proxyInbounds.id, id));
}

/**
 * 删除入站，连同它派生出来的节点。
 *
 * 派生节点必须一起删：留着的话它会继续出现在订阅里，指向一个已经不再监听的
 * 端口 —— 客户端只会看到一个连不上的节点，且界面上看不出原因。
 * deleteProxyNode 自己会解绑引用该节点的转发规则。
 */
export async function deleteProxyInbound(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const derived = await db.select().from(proxyNodes).where(eq(proxyNodes.inboundId, id));
  const { deleteProxyNode } = await import("./proxySubscriptionRepository");
  for (const node of derived) await deleteProxyNode(Number((node as any).id));
  await db.delete(proxyInbounds).where(eq(proxyInbounds.id, id));
  return { releasedNodes: derived.length };
}

/**
 * 一批入站各自属于哪个用户。流量上报要靠它把字节数落到人头上。
 *
 * 一次查完而不是逐条查：一台机器上可能有十几个入站，每次心跳都逐条查是白花的
 * 往返。查不到的 id 不出现在结果里，调用方按「无主流量」丢弃并计入 ignored。
 */
export async function getProxyInboundOwnersByIds(ids: readonly number[]): Promise<Map<number, number>> {
  const owners = new Map<number, number>();
  const wanted = Array.from(new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  if (wanted.length === 0) return owners;
  const db = await getDb();
  if (!db) return owners;
  const rows = await db
    .select({ id: proxyInbounds.id, userId: proxyInbounds.userId })
    .from(proxyInbounds)
    .where(inArray(proxyInbounds.id, wanted));
  for (const row of rows as any[]) owners.set(Number(row.id), Number(row.userId));
  return owners;
}

/**
 * 一台主机上启用中的入站，连用户一起读出来。
 *
 * 心跳每半分钟一次、每台主机一次，所以用户是一次 inArray 查完再分组，而不是
 * 每个入站查一次 —— 那样一台机器上十几个入站就是十几次往返。
 *
 * 心跳侧必须用这个而不是 getEnabledProxyInboundsByHost + proxyInboundFromRow：
 * 后者不带 users，多用户协议会生成一个「零用户」的入站，sing-box 直接拒绝整份配置。
 */
export async function getEnabledProxyInboundsWithUsersByHost(
  hostId: number,
): Promise<Array<{ id: number; port: number; protocol: string; inbound: ProxyInbound }>> {
  const rows = await getEnabledProxyInboundsByHost(hostId);
  if (rows.length === 0) return [];
  const db = await getDb();
  if (!db) return [];

  const ids = (rows as any[]).map((row) => Number(row.id));
  const userRows = await db
    .select()
    .from(proxyInboundUsers)
    .where(inArray(proxyInboundUsers.inboundId, ids))
    .orderBy(asc(proxyInboundUsers.sortOrder), asc(proxyInboundUsers.id));

  /**
   * 分享发出去的凭据要跟着收件人的状态走。
   *
   * 面板那边到期/停用/收回订阅权限，拦住的只是订阅地址 —— 客户端里已经存下的
   * 那份配置照连不误，因为凭据是落在这台机器的 sing-box 上的，没人去删。
   * 「到期就停服」这句话得由这里兑现：算配置时把已经没资格的人剔掉，下一次
   * 心跳（或者一次催下发）他就连不上了。
   *
   * 主人自己那份不在此列 —— 端口本来就是他的，那是另一档策略，不在这里顺手改。
   */
  const recipientIds = Array.from(new Set(
    (userRows as any[]).map((row) => Number(row.sharedUserId || 0)).filter((id) => id > 0),
  ));
  const blockedRecipients = new Set<number>();
  if (recipientIds.length > 0) {
    const recipients = await db
      .select({
        id: users.id,
        role: users.role,
        accountEnabled: users.accountEnabled,
        allowProxySubscription: users.allowProxySubscription,
        expiresAt: users.expiresAt,
      })
      .from(users)
      .where(inArray(users.id, recipientIds));
    const found = new Set<number>();
    for (const row of recipients as any[]) {
      const id = Number(row.id);
      found.add(id);
      if (!proxyCredentialRecipientActive(row)) blockedRecipients.add(id);
    }
    // 人没了（账号被删）凭据也不该活着。
    for (const id of recipientIds) if (!found.has(id)) blockedRecipients.add(id);
  }

  const usersByInbound = new Map<number, ProxyInboundUser[]>();
  for (const row of userRows as any[]) {
    const sharedUserId = Number(row.sharedUserId || 0);
    if (sharedUserId > 0 && blockedRecipients.has(sharedUserId)) continue;
    const key = Number(row.inboundId);
    const list = usersByInbound.get(key) || [];
    list.push({
      id: Number(row.id),
      name: text(row.name),
      uuid: text(row.uuid),
      password: text(row.password),
      sharedUserId,
    });
    usersByInbound.set(key, list);
  }

  return (rows as any[]).map((row) => {
    const inbound = proxyInboundFromRow(row);
    inbound.users = proxyInboundSupportsMultiUser(inbound.protocol) ? (usersByInbound.get(Number(row.id)) || []) : [];
    return { id: Number(row.id), port: Number(row.port) || 0, protocol: String(row.protocol || ""), inbound };
  });
}

// ==================== 入站上的用户 ====================

export async function getProxyInboundUsers(inboundId: number): Promise<ProxyInboundUser[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(proxyInboundUsers)
    .where(eq(proxyInboundUsers.inboundId, inboundId))
    .orderBy(asc(proxyInboundUsers.sortOrder), asc(proxyInboundUsers.id));
  return (rows as any[]).map((row) => ({
    id: Number(row.id),
    name: text(row.name),
    uuid: text(row.uuid),
    password: text(row.password),
    sharedUserId: Number(row.sharedUserId || 0),
  }));
}

/**
 * 一批入站各自的用户，一次查完。
 *
 * 列表接口原来是一行一次 getProxyInboundUsers —— 管理员那边是全量入站，
 * 五十个端口就是五十次往返，页面越用越慢，而慢在哪里从界面上看不出来。
 */
export async function getProxyInboundUsersByInbounds(
  inboundIds: readonly number[],
): Promise<Map<number, ProxyInboundUser[]>> {
  const result = new Map<number, ProxyInboundUser[]>();
  const ids = Array.from(new Set(inboundIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  for (const id of ids) result.set(id, []);
  if (ids.length === 0) return result;

  const db = await getDb();
  if (!db) return result;
  const rows = await db
    .select()
    .from(proxyInboundUsers)
    .where(inArray(proxyInboundUsers.inboundId, ids))
    .orderBy(asc(proxyInboundUsers.sortOrder), asc(proxyInboundUsers.id));
  for (const row of rows as any[]) {
    result.get(Number(row.inboundId))?.push({
      id: Number(row.id),
      name: text(row.name),
      uuid: text(row.uuid),
      password: text(row.password),
      sharedUserId: Number(row.sharedUserId || 0),
    });
  }
  return result;
}

/**
 * 用给定的清单替换这个入站的用户。
 *
 * 带 id 的行按 id 更新，不带 id 的插入，清单里没出现的删掉。**不是整表删了重建**：
 * 重建会换掉所有行的 id，而派生节点是按用户 id 对齐的 —— 那样每次保存都会把全部
 * 客户端节点删掉再新建，订阅里的节点名、转发规则上的绑定、显隐设置全部丢失。
 */
export async function replaceProxyInboundUsers(
  inboundId: number,
  users: readonly ProxyInboundUser[],
): Promise<ProxyInboundUser[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const existing = await getProxyInboundUsers(inboundId);
  const keep = new Set<number>();
  const result: ProxyInboundUser[] = [];
  /**
   * 为分享自动开的凭据不归这张表单管：它是「分享给某人」的产物，取消分享才该
   * 删。表单是全量替换，而旧版前端、或者管理员改别的字段时提交的清单里根本
   * 没有这些行 —— 照单全收的话，管理员随手保存一次入站，租户就集体连不上，
   * 而界面上什么都看不出来。
   */
  const sharedById = new Map(existing.filter((item) => Number(item.sharedUserId || 0) > 0).map((item) => [item.id, item]));

  for (const [index, user] of users.entries()) {
    const id0 = Number(user.id) || 0;
    // 收件人不能被表单改写：来的是几就存几，没提供就沿用库里那一行的值。
    const sharedUserId = id0 > 0 && sharedById.has(id0)
      ? Number(sharedById.get(id0)!.sharedUserId || 0)
      : Number(user.sharedUserId || 0);
    const data = {
      inboundId,
      name: text(user.name),
      uuid: text(user.uuid) || null,
      password: text(user.password) || null,
      sharedUserId,
      sortOrder: index,
    } as Partial<InsertProxyInboundUser>;
    const id = Number(user.id) || 0;
    if (id > 0 && existing.some((item) => item.id === id)) {
      await db.update(proxyInboundUsers).set({ ...data, updatedAt: nowDate() } as any).where(eq(proxyInboundUsers.id, id));
      keep.add(id);
      result.push({ ...user, id });
    } else {
      const created = await insertAndGetId("proxy_inbound_users", data as any);
      keep.add(Number(created));
      result.push({ ...user, id: Number(created) });
    }
  }

  for (const item of existing) {
    if (keep.has(item.id)) continue;
    // 分享发出去的凭据清单里没出现，当作「这次保存没带上」，留着。
    if (Number(item.sharedUserId || 0) > 0) {
      result.push(item);
      continue;
    }
    await db.delete(proxyInboundUsers).where(eq(proxyInboundUsers.id, item.id));
  }
  return result;
}

// ==================== 分享用的独立凭据 ====================

/**
 * 拿着别人分享来的凭据的人，现在还有没有资格连。
 *
 * 三条都要过：账号还开着、还有客户端订阅权限、还没到期。管理员不受订阅权限
 * 那条约束 —— 他本来就绕过那个开关。
 */
export function proxyCredentialRecipientActive(user: {
  role?: unknown;
  accountEnabled?: unknown;
  allowProxySubscription?: unknown;
  expiresAt?: unknown;
} | null | undefined, now = Date.now()): boolean {
  if (!user) return false;
  if (user.accountEnabled === false || user.accountEnabled === 0) return false;
  const isAdmin = String(user.role || "") === "admin";
  if (!isAdmin && !(user.allowProxySubscription === true || user.allowProxySubscription === 1)) return false;
  const expiresAt = user.expiresAt ? new Date(user.expiresAt as any).getTime() : 0;
  if (expiresAt && expiresAt <= now) return false;
  return true;
}

/** 这个入站上为某人单独发的那份凭据。没有就返回 null。 */
export async function getSharedInboundUser(
  inboundId: number,
  sharedUserId: number,
): Promise<ProxyInboundUser | null> {
  const users = await getProxyInboundUsers(inboundId);
  return users.find((user) => Number(user.sharedUserId || 0) === Number(sharedUserId)) || null;
}

/**
 * 给某人在这个入站上开一份独立凭据（已有就直接返回），并同步派生节点。
 *
 * 返回他该拿到的那条 proxy_nodes 行 id —— 分享记的是这一条，而不是原来那条。
 * 这样「取消分享」删掉的是他自己那份凭据，同一个端口上别人的照旧。
 *
 * 只对天然支持多凭据的协议成立。Shadowsocks / Snell 一个端口只有一份 PSK，
 * 硬开多用户会让**已经发出去的所有配置立刻失效**（sing-box 里 users 一存在，
 * 顶层 password 就会被拒），那是另一件事，不在这里偷偷做。
 */
export async function ensureSharedInboundCredential(
  inboundId: number,
  sharedUserId: number,
  label: string,
): Promise<{ nodeId: number; hostId: number; created: boolean } | null> {
  const db = await getDb();
  if (!db) return null;
  const row = await getProxyInboundById(inboundId);
  if (!row) return null;
  const inbound = await loadProxyInbound(inboundId);
  if (!inbound) return null;
  if (!proxyInboundSupportsMultiUser(inbound.protocol)) return null;

  const hostId = Number((row as any).hostId);
  const existing = await getSharedInboundUser(inboundId, sharedUserId);
  if (!existing) {
    const credential = createEmptyProxyInboundUser();
    credential.name = label;
    credential.sharedUserId = Number(sharedUserId);
    for (const kind of proxyInboundUserCredentialKinds(inbound.protocol)) {
      if (kind === "uuid") credential.uuid = randomUUID();
      else credential.password = nanoid(24);
    }
    await insertAndGetId("proxy_inbound_users", {
      inboundId,
      name: credential.name,
      uuid: credential.uuid || null,
      password: credential.password || null,
      sharedUserId: credential.sharedUserId,
      sortOrder: inbound.users.length,
    } as any);
  }

  await syncProxyNodeFromInbound(inboundId);
  const user = await getSharedInboundUser(inboundId, sharedUserId);
  if (!user) return null;
  const nodes = await db
    .select({ id: proxyNodes.id })
    .from(proxyNodes)
    .where(and(eq(proxyNodes.inboundId, inboundId), eq(proxyNodes.inboundUserId, user.id)));
  const nodeId = Number((nodes as any[])[0]?.id || 0);
  if (!nodeId) return null;
  return { nodeId, hostId, created: !existing };
}

/**
 * 收回某人在这个入站上的独立凭据。返回是否真的删了东西。
 *
 * 派生节点由 syncProxyNodeFromInbound 顺带删掉（它按用户对齐，清单里没有的
 * 就走 deleteProxyNode，分享记录也跟着清）。
 */
/**
 * 这个人手上所有分享来的凭据，全部收回。返回受影响的主机 id，调用方催下发。
 *
 * 删账号时必须走一遭：只删 proxy_node_shares 的话，凭据还留在各个端口上活着，
 * 而那个人已经从用户列表里消失了 —— 界面上再也没有入口能收回它，等于留下
 * 一份谁也管不着、却照样能连的身份。
 */
export async function releaseAllSharedCredentialsForUser(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ inboundId: proxyInboundUsers.inboundId })
    .from(proxyInboundUsers)
    .where(eq(proxyInboundUsers.sharedUserId, Number(userId)));
  const inboundIds = Array.from(new Set((rows as any[]).map((row) => Number(row.inboundId)).filter((id) => id > 0)));
  const hostIds = new Set<number>();
  for (const inboundId of inboundIds) {
    const inbound = await getProxyInboundById(inboundId);
    const released = await releaseSharedInboundCredential(inboundId, Number(userId));
    const hostId = Number((inbound as any)?.hostId || 0);
    if (released && hostId > 0) hostIds.add(hostId);
  }
  return Array.from(hostIds);
}

export async function releaseSharedInboundCredential(
  inboundId: number,
  sharedUserId: number,
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const user = await getSharedInboundUser(inboundId, sharedUserId);
  if (!user) return false;
  await db.delete(proxyInboundUsers).where(eq(proxyInboundUsers.id, user.id));
  await syncProxyNodeFromInbound(inboundId);
  return true;
}

// ==================== 派生客户端节点 ====================

/**
 * 入站的对外地址：就是它所在主机的入口地址。
 *
 * 入站自己只知道监听在 ::，不知道对外是哪个 IP；而主机那边已经有一套地址解析
 * （入口 IP、DDNS 域名、v4/v6），直接复用，免得两处各算一份还算得不一样。
 */
/**
 * 每个入站派生出来的节点，以及它们「是否加进订阅」。
 *
 * 自建节点的订阅状态归入站管 —— 派生节点不在「落地节点」那一段列出来（那一段是
 * 粘进来的），所以那个开关得在「新建节点」这边给出入口，否则建完的节点要不要
 * 进订阅就没地方改了。
 */
export async function getProxyInboundDerivedNodes(
  inboundIds: readonly number[],
): Promise<Map<number, { ids: number[]; nodes: Array<{ id: number; inboundUserId: number }>; includeDirect: boolean }>> {
  const result = new Map<number, { ids: number[]; nodes: Array<{ id: number; inboundUserId: number }>; includeDirect: boolean }>();
  const ids = Array.from(new Set(inboundIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  for (const id of ids) result.set(id, { ids: [], nodes: [], includeDirect: false });
  if (ids.length === 0) return result;

  const db = await getDb();
  if (!db) return result;
  const rows = await db
    .select({
      id: proxyNodes.id,
      inboundId: proxyNodes.inboundId,
      inboundUserId: proxyNodes.inboundUserId,
      includeDirect: proxyNodes.includeDirect,
    })
    .from(proxyNodes)
    .where(inArray(proxyNodes.inboundId, ids))
    .orderBy(asc(proxyNodes.inboundUserId), asc(proxyNodes.id));

  for (const row of rows as any[]) {
    const entry = result.get(Number(row.inboundId));
    if (!entry) continue;
    entry.ids.push(Number(row.id));
    /**
     * 带上 inboundUserId：界面要把「哪条节点是哪份凭据」对上号。原来只给一串
     * id，靠它跟用户清单的下标对齐 —— 查询本来就没保证顺序，凭据一增一删就会
     * 对错人，而对错的后果是把 A 的链接当成 B 的发出去。
     */
    entry.nodes.push({ id: Number(row.id), inboundUserId: Number(row.inboundUserId || 0) });
    // 多用户入站有好几条派生节点，只要有一条进了订阅就算开着。
    if (row.includeDirect === true || row.includeDirect === 1) entry.includeDirect = true;
  }
  return result;
}

export async function getProxyInboundAddress(hostId: number): Promise<string> {
  const db = await getDb();
  if (!db) return "";
  const rows = await db.select().from(hosts).where(eq(hosts.id, hostId)).limit(1);
  return rows[0] ? getHostEntryAddress(rows[0] as any) : "";
}

/**
 * 把入站派生成一行 proxy_nodes，订阅那一套原样接上。
 *
 * 主机还没有可用地址时不生成节点：地址为空的节点在订阅里是一条连不上的记录，
 * 不如先不出现，等主机地址就绪后下一次保存再补上。
 */
/**
 * 把入站派生成 proxy_nodes 里的一到多行，订阅那一套原样接上。
 *
 * 多用户协议下一个用户一条节点，按 inboundUserId 对齐：清单里没有的用户，
 * 它那条节点要一起删掉 —— 留着的话订阅里会多出一条凭据已经失效的节点，
 * 客户端只看到连不上，而界面上看不出原因。
 *
 * 主机还没有可用地址时不生成节点：地址为空的节点在订阅里是一条连不上的记录。
 */
export async function syncProxyNodeFromInbound(inboundId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const row = await getProxyInboundById(inboundId);
  if (!row) return [];
  const inbound = await loadProxyInbound(inboundId);
  if (!inbound) return [];

  const address = await getProxyInboundAddress(Number((row as any).hostId));
  const existing = (await db.select().from(proxyNodes).where(eq(proxyNodes.inboundId, inboundId))) as any[];

  if (!address) {
    /**
     * 地址没了（主机被改成无地址）时把已有的派生节点停用而不是删掉：
     * 用户在转发规则上的绑定和改过的节点名都还留着，地址回来就能复用。
     */
    for (const node of existing) {
      await db.update(proxyNodes).set({ isEnabled: false, updatedAt: nowDate() } as any).where(eq(proxyNodes.id, node.id));
    }
    return existing.map((node) => Number(node.id));
  }

  const derived = proxyNodesFromInbound(inbound, { address });
  const byUserId = new Map<number, any>();
  for (const node of existing) byUserId.set(Number(node.inboundUserId || 0), node);

  const kept = new Set<number>();
  const ids: number[] = [];
  for (const { user, node } of derived) {
    const inboundUserId = Number(user?.id || 0);
    const data = {
      userId: Number((row as any).userId),
      inboundId,
      inboundUserId,
      name: node.name,
      protocol: node.protocol,
      address: node.address,
      port: node.port,
      uuid: node.uuid || null,
      password: node.password || null,
      method: node.method || null,
      alterId: node.alterId,
      flow: node.flow || null,
      transport: node.transport,
      path: node.path || null,
      host: node.host || null,
      tls: node.tls,
      sni: node.sni || null,
      alpn: node.alpn.length ? node.alpn.join(",") : null,
      fingerprint: node.fingerprint || null,
      allowInsecure: node.allowInsecure,
      realityPublicKey: node.realityPublicKey || null,
      realityShortId: node.realityShortId || null,
      udp: node.udp,
      obfs: node.obfs || null,
      obfsPassword: node.obfsPassword || null,
      congestionControl: node.congestionControl || null,
      udpRelayMode: node.udpRelayMode || null,
      disableSni: node.disableSni,
      snellVersion: node.snellVersion,
      snellMode: node.snellMode || null,
      xhttpMode: node.xhttpMode || null,
      isEnabled: !!(row as any).isEnabled,
    };
    const current = byUserId.get(inboundUserId);
    if (current) {
      await db.update(proxyNodes).set({ ...data, updatedAt: nowDate() } as any).where(eq(proxyNodes.id, current.id));
      kept.add(Number(current.id));
      ids.push(Number(current.id));
    } else {
      /**
       * 新派生的节点默认「加进订阅」。
       *
       * 这一列对**粘进来的**落地节点默认是关的，因为那种是租来的机器，落地 IP
       * 要藏在中转后面。但自建节点不一样：它就开在自己的主机上，直连本来就是
       * 它的用法，而这一段的说明写的也是「自动进订阅」—— 建完却不出现在订阅里，
       * 那句话就成了假的。
       *
       * 只在新建时给默认值，更新时不动：用户后来手动关掉的话，下次保存入站
       * 不该把他的选择覆盖回去。
       */
      const created = Number(await insertAndGetId("proxy_nodes", { ...data, includeDirect: true } as any));
      kept.add(created);
      ids.push(created);
    }
  }

  // 用户被删掉之后，他那条节点也要走 deleteProxyNode —— 它会顺手解绑引用该节点的转发。
  const { deleteProxyNode } = await import("./proxySubscriptionRepository");
  for (const node of existing) {
    if (!kept.has(Number(node.id))) await deleteProxyNode(Number(node.id));
  }
  return ids;
}
