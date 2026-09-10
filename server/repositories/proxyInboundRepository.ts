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

import { and, asc, eq } from "drizzle-orm";

import {
  hosts,
  proxyInbounds,
  proxyNodes,
  type InsertProxyInbound,
} from "../../drizzle/schema";
import { getDb, insertAndGetId, nowDate } from "../dbRuntime";
import { getHostEntryAddress } from "../../shared/hostEntryAddress";
import {
  createEmptyProxyInbound,
  proxyNodeFromInbound,
  type ProxyInbound,
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

export async function getProxyInboundsByUser(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(proxyInbounds)
    .where(eq(proxyInbounds.userId, userId))
    .orderBy(asc(proxyInbounds.sortOrder), asc(proxyInbounds.id));
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

// ==================== 派生客户端节点 ====================

/**
 * 入站的对外地址：就是它所在主机的入口地址。
 *
 * 入站自己只知道监听在 ::，不知道对外是哪个 IP；而主机那边已经有一套地址解析
 * （入口 IP、DDNS 域名、v4/v6），直接复用，免得两处各算一份还算得不一样。
 */
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
export async function syncProxyNodeFromInbound(inboundId: number): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const row = await getProxyInboundById(inboundId);
  if (!row) return 0;

  const inbound = proxyInboundFromRow(row as any);
  const address = await getProxyInboundAddress(Number((row as any).hostId));
  const existing = (await db.select().from(proxyNodes).where(eq(proxyNodes.inboundId, inboundId)))[0] as any;

  if (!address) {
    // 地址没了（主机被改成无地址）时，把已有的派生节点停用而不是删掉：
    // 用户在转发规则上的绑定和改过的节点名都还留着，地址回来就能复用。
    if (existing) await db.update(proxyNodes).set({ isEnabled: false, updatedAt: nowDate() } as any).where(eq(proxyNodes.id, existing.id));
    return existing ? Number(existing.id) : 0;
  }

  const node = proxyNodeFromInbound(inbound, { address, name: text((row as any).name) });
  const data = {
    userId: Number((row as any).userId),
    inboundId,
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

  if (existing) {
    await db.update(proxyNodes).set({ ...data, updatedAt: nowDate() } as any).where(eq(proxyNodes.id, existing.id));
    return Number(existing.id);
  }
  return insertAndGetId("proxy_nodes", data as any);
}
