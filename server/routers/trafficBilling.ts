import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { appendPanelLog } from "../_core/panelLogger";
import * as db from "../db";
import { reconcileTrafficBillingAuthorization } from "../trafficBillingAuthorization";

const resourceTypeSchema = z.enum(["host", "tunnel", "forward_group"]);

export const trafficBillingRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const [summary, usableResourceIds] = await Promise.all([
      db.getTrafficBillingSummary(ctx.user.id),
      ctx.user.role === "admin"
        ? Promise.resolve({ hostIds: [], tunnelIds: [], forwardGroupIds: [] })
        : db.getUserUsableTrafficBillingResourceIds(ctx.user.id),
    ]);
    return {
      ...summary,
      usableResourceIds,
      hasUsableResources: usableResourceIds.hostIds.length > 0 || usableResourceIds.tunnelIds.length > 0 || usableResourceIds.forwardGroupIds.length > 0,
    };
  }),

  configs: adminProcedure.query(async () => {
    const [enabled, configs] = await Promise.all([
      db.isTrafficBillingEnabled(),
      db.listTrafficBillingConfigs(),
    ]);
    return { enabled, configs };
  }),

  storeResources: protectedProcedure.query(async () => {
    const enabled = await db.isTrafficBillingEnabled();
    if (!enabled) return { enabled, configs: [] };
    return {
      enabled,
      configs: (await db.listTrafficBillingConfigs()).filter((item: any) => item.enabled && !item.requiresPermission),
    };
  }),

  /**
   * 「给这台机器配整台兜底价，会把谁接管过去、会停掉谁」。
   *
   * 保存之前问一次。兜底价会接管这台机器上所有没被单独计价的转发（包括走套餐的
   * 租户的），而余额 ≤ 0 的人会被停掉**名下全部**转发 —— 这件事原来只有等租户
   * 来问「我的转发怎么全停了」才会发现。
   */
  hostTakeoverPreview: adminProcedure
    .input(z.object({ hostId: z.number().int().positive() }))
    .query(async ({ input }) => db.previewHostTrafficBillingTakeover(input.hostId)),

  setEnabled: adminProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      await db.setTrafficBillingEnabled(input.enabled);
      const reconciliation = await reconcileTrafficBillingAuthorization(
        `traffic-billing-${input.enabled ? "enabled" : "disabled"}`,
      );
      appendPanelLog(
        reconciliation.failures.length > 0 ? "warn" : "info",
        `[TrafficBilling] feature ${input.enabled ? "enabled" : "disabled"} affectedUsers=${reconciliation.affectedUsers} disabledRules=${reconciliation.disabledRules} failures=${reconciliation.failures.length}`,
      );
      return { enabled: input.enabled };
    }),

  saveConfig: adminProcedure
    .input(z.object({
      id: z.number().optional(),
      resourceType: resourceTypeSchema,
      resourceId: z.number().int().positive(),
      enabled: z.boolean().default(true),
      requiresPermission: z.boolean().default(false),
      description: z.string().trim().max(500).optional(),
      pricePerGbCents: z.number().int().min(0).max(100_000_000).optional(),
      pricePerGbMilliCents: z.number().int().min(0).max(100_000_000_000).optional(),
      multiplier: z.number().int().min(1).max(5000).optional(),
    }))
    .mutation(async ({ input }) => {
      const config = await db.upsertTrafficBillingConfig(input as any);
      const reconciliation = await reconcileTrafficBillingAuthorization(
        `traffic-billing-config-saved-${input.resourceType}-${input.resourceId}`,
      );
      appendPanelLog(
        reconciliation.failures.length > 0 ? "warn" : "info",
        `[TrafficBilling] config saved ${input.resourceType}=${input.resourceId} priceMilli=${input.pricePerGbMilliCents ?? 0} requiresPermission=${input.requiresPermission} affectedUsers=${reconciliation.affectedUsers} disabledRules=${reconciliation.disabledRules} failures=${reconciliation.failures.length}`,
      );
      // 把「顺带停掉了几条转发」原样带回去。改计费资源会牵动授权：靠这个资源
      // 才用得上某台机器的用户，资源一变就可能失去访问，他的转发被停。界面不说
      // 的话，这件事只在服务端日志里 —— 而挨停的是别人的业务。
      return { ...(config as any), disabledRules: reconciliation.disabledRules };
    }),

  deleteConfig: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.deleteTrafficBillingConfig(input.id);
      const reconciliation = await reconcileTrafficBillingAuthorization(
        `traffic-billing-config-deleted-${input.id}`,
      );
      appendPanelLog(
        reconciliation.failures.length > 0 ? "warn" : "info",
        `[TrafficBilling] config deleted id=${input.id} affectedUsers=${reconciliation.affectedUsers} disabledRules=${reconciliation.disabledRules} failures=${reconciliation.failures.length}`,
      );
      return { success: true, disabledRules: reconciliation.disabledRules };
    }),

  records: protectedProcedure
    .input(z.object({
      userId: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }).optional())
    .query(async ({ input, ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      return db.listTrafficBillingRecords({
        userId: isAdmin ? input?.userId : ctx.user.id,
        limit: input?.limit || 100,
      });
    }),
});
