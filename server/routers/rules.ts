import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { crudRulesRouter } from "./rules.crud";
import { portsRulesRouter } from "./rules.ports";
import { selfTestRulesRouter } from "./rules.selfTest";
import { trafficRulesRouter } from "./rules.traffic";
import { canUseForwardRuleResource, getLinkAccessScope } from "../linkAccessView";
import { isManagedForwardGroupChildRule } from "../forwardRuleVisibility";
import { formatHostAddressWithPort, getHostEntryAddress } from "@shared/hostEntryAddress";
import { isForwardRuleProtocolTcpEnabled, isUserspaceForwardType } from "@shared/forwardTypes";

async function withRuleResourceAccess<T extends any>(value: T, user: { id: number; role: string }): Promise<T> {
  if (user.role === "admin") return value;
  const scope = await getLinkAccessScope(user);
  const decorate = (rule: any) => ({
    ...rule,
    resourceAccessAllowed: canUseForwardRuleResource(rule, scope),
  });
  if (Array.isArray(value)) return value.map(decorate) as T;
  if (value && Array.isArray((value as any).items)) {
    return { ...value, items: (value as any).items.map(decorate) } as T;
  }
  return (value ? decorate(value) : value) as T;
}


type RuleListCategory = "all" | "local" | "tunnel" | "chain" | "group";
type RuleResourceType = "local" | "tunnel" | "chain" | "group";
type RuleListFilters = {
  userId?: number;
  scope?: "self" | "all";
  entryHostId?: number | null;
  resourceType?: RuleResourceType | null;
  resourceId?: number | null;
  category: RuleListCategory;
  search: string;
};

async function getRuleListRepositoryInput(
  input: RuleListFilters,
  user: { id: number; role: string },
) {
  const isAdmin = user.role === "admin";
  const accessScope = isAdmin ? null : await getLinkAccessScope(user);
  const ownerUserId = isAdmin
    ? input.scope === "all"
      ? undefined
      : input.userId ?? user.id
    : user.id;
  return {
    ownerUserId,
    searchVisibleHostIds: accessScope
      ? Array.from(accessScope.useHostIds || accessScope.hostIds)
      : undefined,
    searchVisibleTunnelIds: accessScope
      ? Array.from(accessScope.useTunnelIds || accessScope.tunnelIds)
      : undefined,
    searchVisibleForwardGroupIds: accessScope
      ? Array.from(accessScope.useGroupIds || accessScope.groupIds)
      : undefined,
    entryHostId: input.entryHostId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    category: input.category,
    search: input.search,
  };
}

export const rulesRouter = router({
  list: protectedProcedure
    .input(z.object({
      hostId: z.number().optional(),
      userId: z.number().optional(),
      scope: z.enum(["self", "all"]).optional(),
      tunnelId: z.number().nullable().optional(),
    }).optional())
    .query(async ({ input, ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      const requestedUserId = isAdmin
        ? input?.scope === "all"
          ? undefined
          : input?.userId ?? ctx.user.id
        : ctx.user.id;
      const rules = await db.getForwardRules(requestedUserId, input?.hostId);
      const filtered = input?.tunnelId === undefined
        ? rules
        : input.tunnelId === null
          ? rules.filter((rule: any) => !rule.tunnelId)
          : rules.filter((rule: any) => Number(rule.tunnelId || 0) === Number(input.tunnelId));
      return withRuleResourceAccess(filtered, ctx.user);
    }),
  listPage: protectedProcedure
    .input(z.object({
      page: z.number().int().positive().default(1),
      pageSize: z.number().int().min(1).max(100).default(12),
      userId: z.number().optional(),
      scope: z.enum(["self", "all"]).optional(),
      entryHostId: z.number().int().positive().nullable().optional(),
      resourceType: z.enum(["local", "tunnel", "chain", "group"]).nullable().optional(),
      resourceId: z.number().int().positive().nullable().optional(),
      category: z.enum(["all", "local", "tunnel", "chain", "group"]).default("all"),
      search: z.string().trim().max(200).optional().default(""),
    }))
    .query(async ({ input, ctx }) => {
      const repositoryInput = await getRuleListRepositoryInput(input, ctx.user);
      const page = await db.getForwardRulesPage({ ...repositoryInput, page: input.page, pageSize: input.pageSize });
      return withRuleResourceAccess(page, ctx.user);
    }),
  mapItems: protectedProcedure
    .input(z.object({
      cursor: z.number().int().min(0).optional(),
      limit: z.number().int().min(20).max(250).default(100),
      userId: z.number().optional(),
      scope: z.enum(["self", "all"]).optional(),
      entryHostId: z.number().int().positive().nullable().optional(),
      resourceType: z.enum(["local", "tunnel", "chain", "group"]).nullable().optional(),
      resourceId: z.number().int().positive().nullable().optional(),
      category: z.enum(["all", "local", "tunnel", "chain", "group"]).default("all"),
      search: z.string().trim().max(200).optional().default(""),
    }))
    .query(async ({ input, ctx }) => {
      const repositoryInput = await getRuleListRepositoryInput(input, ctx.user);
      const batch = await db.getForwardRuleMapBatch(repositoryInput, input.cursor || 0, input.limit);
      return withRuleResourceAccess(batch, ctx.user);
    }),
  listSummary: protectedProcedure
    .input(z.object({
      userId: z.number().optional(),
      scope: z.enum(["self", "all"]).optional(),
      entryHostId: z.number().int().positive().nullable().optional(),
      resourceType: z.enum(["local", "tunnel", "chain", "group"]).nullable().optional(),
      resourceId: z.number().int().positive().nullable().optional(),
      category: z.enum(["all", "local", "tunnel", "chain", "group"]).default("all"),
      search: z.string().trim().max(200).optional().default(""),
    }))
    .query(async ({ input, ctx }) => {
      const repositoryInput = await getRuleListRepositoryInput(input, ctx.user);
      const selection = await db.getForwardRuleSummarySelection(repositoryInput);
      const [totalRows, dailyRows] = selection.ruleIds.length > 0
        ? await Promise.all([
          db.getTrafficCounterSummaryByRule({
            userId: ctx.user.role === "admin" ? undefined : ctx.user.id,
            ruleIds: selection.ruleIds,
          }),
          db.getTrafficSummaryByRule({
            userId: ctx.user.role === "admin" ? undefined : ctx.user.id,
            ruleIds: selection.ruleIds,
            since: new Date(Date.now() - 24 * 60 * 60 * 1000),
          }),
        ])
        : [[], []];
      const sumRows = (rows: any[]) => rows.reduce((total, row) => ({
        bytesIn: total.bytesIn + Math.max(0, Number(row?.bytesIn) || 0),
        bytesOut: total.bytesOut + Math.max(0, Number(row?.bytesOut) || 0),
        connections: total.connections + Math.max(0, Number(row?.connections) || 0),
      }), { bytesIn: 0, bytesOut: 0, connections: 0 });
      return {
        totalItems: selection.totalItems,
        activeItems: selection.activeItems,
        totalTraffic: sumRows(totalRows as any[]),
        dailyTraffic: sumRows(dailyRows as any[]),
      };
    }),
  getById: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.id);
      if (!rule) return null;
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) return null;
      if (ctx.user.role !== "admin" && isManagedForwardGroupChildRule(rule)) return null;
      return withRuleResourceAccess(rule, ctx.user);
    }),
  /**
   * 能当「备用出站」用的中转。
   *
   * 主备的备用出站原来是个多行文本框，得自己手填 `地址:端口` —— 而面板里明明就有
   * 这些中转：它们是一条条指向落地的转发规则。手填的代价不只是麻烦：
   *
   *   · 填错了不会有任何提示，要等真出事那天才发现备用线路根本连不上；
   *   · 面板知道那台中转用的是哪种转发方式，而**这直接决定了健康检查有没有盲区**
   *     （用户态转发时，连得上只证明中转活着，它到落地那段断了照样探不出来）——
   *     手填的地址让面板没法把这件事告诉用户。
   *
   * 所以这里把候选列出来，连带每条的转发方式、它自己指向哪个落地一起给界面。
   * 界面据此可以当场说清楚：这条出站通到哪儿、和主出站是不是同一个落地、
   * 要不要另配探测目标。
   */
  relayCandidates: protectedProcedure
    .input(z.object({ excludeRuleId: z.number().int().positive().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      const rules = await db.getForwardRules(isAdmin ? undefined : ctx.user.id);
      /*
        主机按**规则引用到的 id** 取，不按归属取。

        租户的规则可以跑在管理员的按量计费主机上 —— 按归属取的话这些中转会整批消失，
        而用户在自己的规则行上明明看得见它们。只查规则引用到的那些，也不会多暴露
        任何东西：规则本来就是他自己的。
      */
      const hostIds = Array.from(new Set((rules as any[])
        .map((rule: any) => Number(rule?.hostId || 0))
        .filter((hostId: number) => hostId > 0)));
      const hosts = hostIds.length > 0 ? await db.getHostsByIds(hostIds) : [];
      const hostById = new Map((hosts as any[]).map((host: any) => [Number(host.id), host]));
      const excluded = Number(input?.excludeRuleId || 0);
      const candidates: Array<{
        id: number;
        label: string;
        hostName: string;
        address: string;
        forwardType: string;
        userspaceRelay: boolean;
        targetIp: string;
        targetPort: number;
      }> = [];
      for (const rule of rules as any[]) {
        const id = Number(rule?.id || 0);
        if (!id || id === excluded) continue;
        // 备用出站是 TCP 的（主备本身只支持 TCP），关掉的规则不该出现在候选里 ——
        // 选了等于配了一条一定连不上的备用线路。
        if (!isForwardRuleProtocolTcpEnabled(rule?.protocol)) continue;
        if (rule?.isEnabled === false) continue;
        const sourcePort = Number(rule?.sourcePort || 0);
        if (!(sourcePort >= 1 && sourcePort <= 65535)) continue;
        const host = hostById.get(Number(rule?.hostId || 0));
        if (!host) continue;
        const entryAddress = getHostEntryAddress(host);
        if (!entryAddress) continue;
        candidates.push({
          id,
          label: String(rule?.name || `规则 #${id}`),
          hostName: String(host?.name || `主机 ${host?.id}`),
          address: formatHostAddressWithPort(entryAddress, sourcePort),
          forwardType: String(rule?.forwardType || ""),
          userspaceRelay: isUserspaceForwardType(rule?.forwardType),
          targetIp: String(rule?.targetIp || ""),
          targetPort: Number(rule?.targetPort || 0),
        });
      }
      return candidates;
    }),
  reorder: protectedProcedure
    .input(z.object({
      category: z.enum(["local", "tunnel", "chain", "group"]),
      ids: z.array(z.number().int().positive()).min(1),
      startIndex: z.number().int().min(0).max(1_000_000).optional().default(0),
    }))
    .mutation(async ({ input, ctx }) => {
      await db.reorderForwardRules(input.category, input.ids, ctx.user.role === "admin" ? undefined : ctx.user.id, input.startIndex);
      return { success: true };
    }),
  ...portsRulesRouter._def.procedures,
  ...crudRulesRouter._def.procedures,
  ...trafficRulesRouter._def.procedures,
  ...selfTestRulesRouter._def.procedures,
});
