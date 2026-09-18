import { and, eq, sql } from "drizzle-orm";
import { forwardGroups, forwardRules, hosts } from "../../drizzle/schema";
import { getDb } from "../dbRuntime";
import { sqlCountAll } from "../dbCompat";
import { getTotalTraffic, getTrafficSummaryByRule } from "./metricsRepository";
import { clampPositiveInt, epochSeconds, sqlBool } from "./repositoryUtils";
import { resolveDashboardTrafficRuleIdentity } from "../dashboardTrafficIdentity";
import { HOST_ONLINE_TTL_MS } from "../hostHeartbeatPolicy";

type DashboardTrafficBreakdownItem = {
  id: number;
  name: string;
  bytesIn: number;
  bytesOut: number;
  totalBytes: number;
};

type TrafficSummaryItem = {
  ruleId: number;
  hostId: number;
  bytesIn: number;
  bytesOut: number;
  connections: number;
};

type RuleTrafficBucket = "tunnelRules" | "portRules" | "forwardGroupRules";

type RuleTrafficMeta = {
  trafficId: number;
  name: string;
  forwardType: string;
  tunnelId: number | null;
  forwardGroupId: number | null;
  forwardGroupRuleId: number | null;
  forwardGroupMemberId: number | null;
  forwardGroupMode: string | null;
  isForwardGroupTemplate: boolean;
};

function emptyTrafficBreakdown() {
  return {
    tunnelRules: [] as DashboardTrafficBreakdownItem[],
    portRules: [] as DashboardTrafficBreakdownItem[],
    forwardGroupRules: [] as DashboardTrafficBreakdownItem[],
  };
}

function addTraffic(
  map: Map<number, DashboardTrafficBreakdownItem>,
  id: number,
  name: string,
  bytesIn: number,
  bytesOut: number,
) {
  if (!id) return;
  const totalBytes = bytesIn + bytesOut;
  if (totalBytes <= 0) return;
  const prev = map.get(id);
  if (prev) {
    prev.bytesIn += bytesIn;
    prev.bytesOut += bytesOut;
    prev.totalBytes += totalBytes;
    return;
  }
  map.set(id, { id, name, bytesIn, bytesOut, totalBytes });
}

function sortTrafficItems(map: Map<number, DashboardTrafficBreakdownItem>, limit: number) {
  return Array.from(map.values())
    .sort((a, b) => b.totalBytes - a.totalBytes)
    .slice(0, limit);
}

function getRuleTrafficBucket(rule: RuleTrafficMeta | undefined): RuleTrafficBucket {
  if (
    rule?.isForwardGroupTemplate ||
    rule?.forwardGroupId ||
    rule?.forwardGroupRuleId ||
    rule?.forwardGroupMemberId
  ) {
    if (rule?.forwardGroupMode === "port") return "portRules";
    return "forwardGroupRules";
  }
  if (rule?.tunnelId) return "tunnelRules";
  return "portRules";
}

// ==================== 系统健康摘要 ====================

export type SystemHealthSummary = {
  hosts: { total: number; online: number; offline: number; neverConnected: number };
  links: { total: number; healthy: number; unhealthy: number };
  forwards: { total: number; running: number; stalled: number; disabled: number };
  /** 异常总数：掉线主机 + 不健康线路 + 该跑没跑的转发。0 表示一切正常。 */
  issues: number;
};

/**
 * 首页那一行要回答的唯一问题：现在系统是否正常。
 *
 * 之前首页顶上挂着一个写死的绿色「系统在线」—— 后面没有任何数据，掉多少台机器
 * 它都是绿的。这个函数就是为了让那句话有据可依。
 *
 * 三类异常各有各的判据，故意不合成一个笼统的「不健康」：
 *
 *   - **主机掉线**：收过心跳、但已经超时。从没收过心跳的算「还没装 Agent」，
 *     那是一步没做完，不是出了故障，混在一起会让新加的机器天天报异常。
 *   - **线路不健康**：隧道该跑没跑，或转发组自己报了 down / error。转发组的
 *     unknown 不算异常 —— 那是「还没测过」。
 *   - **转发该跑没跑**：isEnabled 为真而 isRunning 为假。这个数在主机掉线后
 *     会跟着变准（掉线时会清运行状态），在那之前它一直是个谎。
 *
 * 全部用 SQL 聚合，一次五条计数查询，和机器数量无关 —— 首页是所有人的落地页，
 * 不能把整表拉回来再在内存里数。
 */
export async function getSystemHealthSummary(userId?: number): Promise<SystemHealthSummary> {
  const empty: SystemHealthSummary = {
    hosts: { total: 0, online: 0, offline: 0, neverConnected: 0 },
    links: { total: 0, healthy: 0, unhealthy: 0 },
    forwards: { total: 0, running: 0, stalled: 0, disabled: 0 },
    issues: 0,
  };
  const db = await getDb();
  if (!db) return empty;

  const freshSince = epochSeconds(new Date(Date.now() - HOST_ONLINE_TTL_MS));
  const online = sql`${hosts.isOnline} = ${sqlBool(true)} AND ${hosts.lastHeartbeat} >= ${freshSince}`;
  const neverConnected = sql`${hosts.lastHeartbeat} IS NULL`;

  const hostRows = await db
    .select({
      total: sqlCountAll(),
      online: sql<number>`COALESCE(SUM(CASE WHEN ${online} THEN 1 ELSE 0 END), 0)`,
      neverConnected: sql<number>`COALESCE(SUM(CASE WHEN ${neverConnected} THEN 1 ELSE 0 END), 0)`,
    })
    .from(hosts)
    .where(userId ? eq(hosts.userId, userId) : undefined);

  /**
   * 转发只数「用户眼里的那一条」：转发组派生出来的子规则不算，否则一个五成员的
   * 转发组会让首页多出五条转发，而界面上从来只显示一条。
   */
  const ruleWhere = and(
    eq(forwardRules.pendingDelete, false),
    sql`${forwardRules.forwardGroupRuleId} IS NULL`,
    ...(userId ? [eq(forwardRules.userId, userId)] : []),
  );
  const ruleRows = await db
    .select({
      total: sqlCountAll(),
      running: sql<number>`COALESCE(SUM(CASE WHEN ${forwardRules.isEnabled} = ${sqlBool(true)} AND ${forwardRules.isRunning} = ${sqlBool(true)} THEN 1 ELSE 0 END), 0)`,
      stalled: sql<number>`COALESCE(SUM(CASE WHEN ${forwardRules.isEnabled} = ${sqlBool(true)} AND ${forwardRules.isRunning} = ${sqlBool(false)} THEN 1 ELSE 0 END), 0)`,
      disabled: sql<number>`COALESCE(SUM(CASE WHEN ${forwardRules.isEnabled} = ${sqlBool(false)} THEN 1 ELSE 0 END), 0)`,
    })
    .from(forwardRules)
    .where(ruleWhere);

  const { tunnels } = await import("../../drizzle/schema");
  const tunnelRows = await db
    .select({
      total: sqlCountAll(),
      unhealthy: sql<number>`COALESCE(SUM(CASE WHEN ${tunnels.isEnabled} = ${sqlBool(true)} AND ${tunnels.isRunning} = ${sqlBool(false)} THEN 1 ELSE 0 END), 0)`,
    })
    .from(tunnels)
    .where(userId ? eq(tunnels.userId, userId) : undefined);

  const groupRows = await db
    .select({
      total: sqlCountAll(),
      // unknown 是「还没测过」，不是异常；只有明确报坏的才算。
      unhealthy: sql<number>`COALESCE(SUM(CASE WHEN ${forwardGroups.isEnabled} = ${sqlBool(true)} AND ${forwardGroups.lastStatus} IN ('down', 'error') THEN 1 ELSE 0 END), 0)`,
    })
    .from(forwardGroups)
    .where(userId ? eq(forwardGroups.userId, userId) : undefined);

  const n = (value: unknown) => Math.max(0, Math.trunc(Number(value) || 0));
  const hostTotal = n(hostRows[0]?.total);
  const hostOnline = n(hostRows[0]?.online);
  const hostNever = n(hostRows[0]?.neverConnected);
  // 掉线 = 连过但现在不在线。从没连过的单独算，不计入异常。
  const hostOffline = Math.max(0, hostTotal - hostOnline - hostNever);

  const linkTotal = n(tunnelRows[0]?.total) + n(groupRows[0]?.total);
  const linkUnhealthy = n(tunnelRows[0]?.unhealthy) + n(groupRows[0]?.unhealthy);
  const stalled = n(ruleRows[0]?.stalled);

  return {
    hosts: { total: hostTotal, online: hostOnline, offline: hostOffline, neverConnected: hostNever },
    links: { total: linkTotal, healthy: Math.max(0, linkTotal - linkUnhealthy), unhealthy: linkUnhealthy },
    forwards: {
      total: n(ruleRows[0]?.total),
      running: n(ruleRows[0]?.running),
      stalled,
      disabled: n(ruleRows[0]?.disabled),
    },
    issues: hostOffline + linkUnhealthy + stalled,
  };
}

// ==================== Dashboard Stats ====================

export async function getDashboardStats(userId?: number, opts: { includeTraffic?: boolean } = {}) {
  const db = await getDb();
  if (!db) return { totalHosts: 0, onlineHosts: 0, totalRules: 0, activeRules: 0, totalTrafficIn: 0, totalTrafficOut: 0 };

  const heartbeatFreshSince = epochSeconds(new Date(Date.now() - HOST_ONLINE_TTL_MS));
  const hostConditions = userId ? eq(hosts.userId, userId) : undefined;
  const ruleConditions = [
    eq(forwardRules.pendingDelete, false),
    sql`${forwardRules.forwardGroupRuleId} IS NULL`,
    ...(userId ? [eq(forwardRules.userId, userId)] : []),
  ];

  const hostStatsQuery = db
    .select({
      totalHosts: sqlCountAll(),
      onlineHosts: sql<number>`COALESCE(SUM(CASE WHEN ${hosts.isOnline} = ${sqlBool(true)} AND ${hosts.lastHeartbeat} >= ${heartbeatFreshSince} THEN 1 ELSE 0 END), 0)`,
    })
    .from(hosts)
    .where(hostConditions as any);

  const ruleStatsQuery = db
    .select({
      totalRules: sqlCountAll(),
      activeRules: sql<number>`SUM(CASE WHEN ${forwardRules.isEnabled} = ${sqlBool(true)} THEN 1 ELSE 0 END)`,
    })
    .from(forwardRules)
    .where(and(...ruleConditions));

  const [hostStatsRows, ruleStatsRows, traffic] = await Promise.all([
    hostStatsQuery,
    ruleStatsQuery,
    opts.includeTraffic === false ? Promise.resolve({ totalIn: 0, totalOut: 0 }) : getTotalTraffic(userId),
  ]);
  const hostStats = hostStatsRows[0];
  const ruleStats = ruleStatsRows[0];

  return {
    totalHosts: Number(hostStats?.totalHosts) || 0,
    onlineHosts: Number(hostStats?.onlineHosts) || 0,
    totalRules: Number(ruleStats?.totalRules) || 0,
    activeRules: Number(ruleStats?.activeRules) || 0,
    totalTrafficIn: traffic.totalIn,
    totalTrafficOut: traffic.totalOut,
  };
}

// ==================== Dashboard Traffic Breakdown ====================

export async function getDashboardTrafficBreakdown(opts: {
  userId?: number;
  since?: Date;
  limit?: number;
} = {}) {
  const db = await getDb();
  if (!db) return emptyTrafficBreakdown();

  const limit = clampPositiveInt(opts.limit, 30, 100);
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const summaries = await getTrafficSummaryByRule({ userId: opts.userId, since, includeLatency: false }) as TrafficSummaryItem[];
  if (summaries.length === 0) return emptyTrafficBreakdown();

  const ruleIds = Array.from(new Set(summaries.map((item) => Number(item.ruleId)).filter(Boolean)));
  const ruleRows = ruleIds.length
    ? await db
      .select({
        id: forwardRules.id,
        name: forwardRules.name,
        forwardType: forwardRules.forwardType,
        tunnelId: forwardRules.tunnelId,
        forwardGroupId: forwardRules.forwardGroupId,
        forwardGroupRuleId: forwardRules.forwardGroupRuleId,
        forwardGroupMemberId: forwardRules.forwardGroupMemberId,
        forwardGroupMode: forwardGroups.groupMode,
        isForwardGroupTemplate: forwardRules.isForwardGroupTemplate,
      })
      .from(forwardRules)
      .leftJoin(forwardGroups, eq(forwardGroups.id, forwardRules.forwardGroupId))
      .where(sql`${forwardRules.id} IN (${sql.join(ruleIds.map((id) => sql`${id}`), sql`, `)})`)
    : [];

  const templateRuleIds = Array.from(new Set((ruleRows as any[])
    .map((row: any) => Number(row.forwardGroupRuleId || 0))
    .filter((id: number) => Number.isInteger(id) && id > 0)));
  const templateRows = templateRuleIds.length
    ? await db
      .select({
        id: forwardRules.id,
        name: forwardRules.name,
      })
      .from(forwardRules)
      .where(sql`${forwardRules.id} IN (${sql.join(templateRuleIds.map((id) => sql`${id}`), sql`, `)})`)
    : [];
  const templateNames = new Map<number, string>((templateRows as any[]).map((row: any) => [
    Number(row.id),
    String(row.name || "").trim(),
  ]));

  const ruleMeta = new Map<number, RuleTrafficMeta>();
  for (const row of ruleRows as any[]) {
    const identity = resolveDashboardTrafficRuleIdentity(row.id, row, templateNames);
    ruleMeta.set(Number(row.id), {
      trafficId: identity.id,
      name: identity.name,
      forwardType: String(row.forwardType || ""),
      tunnelId: row.tunnelId ? Number(row.tunnelId) : null,
      forwardGroupId: row.forwardGroupId ? Number(row.forwardGroupId) : null,
      forwardGroupRuleId: row.forwardGroupRuleId ? Number(row.forwardGroupRuleId) : null,
      forwardGroupMemberId: row.forwardGroupMemberId ? Number(row.forwardGroupMemberId) : null,
      forwardGroupMode: row.forwardGroupMode ? String(row.forwardGroupMode) : null,
      isForwardGroupTemplate: !!row.isForwardGroupTemplate,
    });
  }

  const tunnelRuleTotals = new Map<number, DashboardTrafficBreakdownItem>();
  const portRuleTotals = new Map<number, DashboardTrafficBreakdownItem>();
  const forwardGroupRuleTotals = new Map<number, DashboardTrafficBreakdownItem>();
  const totalsByBucket: Record<RuleTrafficBucket, Map<number, DashboardTrafficBreakdownItem>> = {
    tunnelRules: tunnelRuleTotals,
    portRules: portRuleTotals,
    forwardGroupRules: forwardGroupRuleTotals,
  };

  for (const item of summaries) {
    const ruleId = Number(item.ruleId);
    const bytesIn = Number(item.bytesIn) || 0;
    const bytesOut = Number(item.bytesOut) || 0;
    const rule = ruleMeta.get(ruleId);
    const bucket = getRuleTrafficBucket(rule);
    addTraffic(totalsByBucket[bucket], rule?.trafficId || ruleId, rule?.name || `规则 #${ruleId}`, bytesIn, bytesOut);
  }

  return {
    tunnelRules: sortTrafficItems(tunnelRuleTotals, limit),
    portRules: sortTrafficItems(portRuleTotals, limit),
    forwardGroupRules: sortTrafficItems(forwardGroupRuleTotals, limit),
  };
}
