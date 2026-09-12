import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { appendPanelLog } from "../_core/panelLogger";
import * as db from "../db";
import { refreshUserForwardEndpoints } from "./helpers";
import { parseExpiryReminderDays } from "@shared/expiryReminder";

const planInput = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).nullable().optional(),
  priceCents: z.number().int().min(0).max(100_000_000),
  currency: z.string().trim().min(3).max(8).default("CNY"),
  durationDays: z.union([
    z.literal(30),
    z.literal(90),
    z.literal(180),
    z.literal(365),
    z.literal(730),
  ]).default(30),
  portCount: z.number().int().min(1).max(1024).default(20),
  trafficLimit: z.number().int().min(0).default(0),
  rateLimitMbps: z.number().int().min(0).max(1_000_000).default(0),
  maxRules: z.number().int().min(0).default(20),
  /** 套餐附带的自建落地节点数，0 = 不限。 */
  maxProxyInbounds: z.number().int().min(0).default(0),
  /** 套餐附带的订阅地址条数，0 = 不限。 */
  maxProxySubTokens: z.number().int().min(0).default(0),
  maxConnections: z.number().int().min(0).max(1_000_000).default(2000),
  maxIPs: z.number().int().min(0).max(100_000).default(10),
  allowProxySubscription: z.boolean().default(false),
  isActive: z.boolean().default(true),
  isStoreVisible: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  hostIds: z.array(z.number().int().positive()).default([]),
  tunnelIds: z.array(z.number().int().positive()).default([]),
  forwardGroupIds: z.array(z.number().int().positive()).default([]),
  /**
   * 套餐附带的落地节点。买了（或被分配）自动在这些节点上发一份独立凭据，
   * 到期、取消、换套餐自动收回 —— 不必每来一个客户手工分一次。
   */
  proxyNodeIds: z.array(z.number().int().positive()).max(200).default([]),
  trafficAddons: z.array(z.object({
    trafficBytes: z.number().int().positive(),
    priceCents: z.number().int().min(0).max(100_000_000),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(9999).default(0),
  })).max(20).default([]),
});

export const plansRouter = router({
  storeStatus: protectedProcedure.query(async () => {
    return { enabled: (await db.getSetting("storeEnabled")) === "true" };
  }),
  setStoreEnabled: adminProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      await db.setSetting("storeEnabled", input.enabled ? "true" : "false");
      appendPanelLog("info", `[Store] ${input.enabled ? "enabled" : "disabled"}`);
      return { success: true };
    }),
  list: adminProcedure.query(async () => {
    return db.listSubscriptionPlans(true);
  }),
  /** 套餐能挂哪些落地节点。跟分享用的是同一份清单，不含任何凭据。 */
  proxyNodeOptions: adminProcedure.query(async () => {
    return db.getProxyNodeShareOptions();
  }),
  options: adminProcedure.query(async () => {
    return db.listSubscriptionPlanOptions(true);
  }),
  summary: adminProcedure.query(async () => {
    return db.getSubscriptionPlanSummary();
  }),
  listPage: adminProcedure
    .input(z.object({
      page: z.number().int().positive().default(1),
      pageSize: z.number().int().min(1).max(100).default(12),
    }))
    .query(async ({ input }) => {
      return db.listSubscriptionPlansPage(input);
    }),
  storeList: protectedProcedure.query(async () => {
    if ((await db.getSetting("storeEnabled")) !== "true") return [];
    return db.listSubscriptionPlans(false);
  }),
  create: adminProcedure
    .input(planInput)
    .mutation(async ({ input }) => {
      const { hostIds, tunnelIds, forwardGroupIds, trafficAddons, proxyNodeIds, ...data } = input;
      if (hostIds.length === 0 && tunnelIds.length === 0 && forwardGroupIds.length === 0) {
        throw new Error("套餐至少需要绑定一个端口转发、隧道、转发链或转发组");
      }
      return db.createSubscriptionPlan({
        ...data,
        description: data.description || null,
        currency: data.currency.toUpperCase(),
      } as any, hostIds, tunnelIds, forwardGroupIds, trafficAddons, proxyNodeIds);
    }),
  update: adminProcedure
    .input(planInput.extend({
      id: z.number().int().positive(),
      syncExistingSubscribers: z.boolean().default(true),
    }))
    .mutation(async ({ input, ctx }) => {
      const { id, hostIds, tunnelIds, forwardGroupIds, trafficAddons, proxyNodeIds, syncExistingSubscribers, ...data } = input;
      if (hostIds.length === 0 && tunnelIds.length === 0 && forwardGroupIds.length === 0) {
        throw new Error("套餐至少需要绑定一个端口转发、隧道、转发链或转发组");
      }
      if (!syncExistingSubscribers) {
        await db.freezePlanSubscriberSnapshots(id);
      }
      const result = await db.updateSubscriptionPlan(id, {
        ...data,
        description: data.description || null,
        currency: data.currency.toUpperCase(),
      } as any, hostIds, tunnelIds, forwardGroupIds, trafficAddons, proxyNodeIds);
      if (syncExistingSubscribers) {
        const userIds = await db.syncPlanSubscribers(id);
        for (const userId of userIds) {
          await refreshUserForwardEndpoints(userId, "plan-updated");
        }
        appendPanelLog("info", `[Plan] updated plan=${id} syncSubscribers=true users=${userIds.length} operator=${ctx.user.id}`);
      } else {
        appendPanelLog("info", `[Plan] updated plan=${id} syncSubscribers=false operator=${ctx.user.id}`);
      }
      return result;
    }),
  updateStatus: adminProcedure
    .input(z.object({
      id: z.number().int().positive(),
      isActive: z.boolean(),
      isStoreVisible: z.boolean(),
    }))
    .mutation(async ({ input }) => {
      return db.updateSubscriptionPlan(input.id, {
        isActive: input.isActive,
        isStoreVisible: input.isActive && input.isStoreVisible,
      } as any);
    }),
  delete: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.deleteSubscriptionPlan(input.id);
      return { success: true };
    }),
  subscriptions: adminProcedure
    .input(z.object({ userId: z.number().optional() }).optional())
    .query(async ({ input }) => {
      await db.expireUserSubscriptions();
      return db.listUserSubscriptions(input?.userId, { visibility: "admin" });
    }),
  subscriptionsPage: adminProcedure
    .input(z.object({
      userId: z.number().optional(),
      page: z.number().int().positive().default(1),
      pageSize: z.number().int().min(1).max(100).default(12),
    }))
    .query(async ({ input }) => {
      await db.expireUserSubscriptions();
      return db.listUserSubscriptionsPage({
        ...input,
        excludeCancelled: true,
        visibility: "admin",
      });
    }),
  /**
   * 快到期了没有 —— 给面板顶上那条横幅用。
   *
   * 邮件和 Telegram 提醒都要求用户先绑定；没绑的人（多数）在到期前收不到任何
   * 消息，断了才发现。这条谁都看得见，成本也只是一次很轻的查询。
   */
  myExpiryNotice: protectedProcedure.query(async ({ ctx }) => {
    const subscriptions = await db.listUserSubscriptions(ctx.user.id, { visibility: "user" });
    const now = Date.now();
    const soonest = (subscriptions as any[])
      .filter((row) => row.status === "active" && row.expiresAt && new Date(row.expiresAt).getTime() > now)
      .sort((a, b) => new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime())[0];
    if (!soonest) return { daysLeft: null as number | null, expiresAt: null as string | null, planName: "" };
    const daysLeft = Math.ceil((new Date(soonest.expiresAt).getTime() - now) / (24 * 60 * 60 * 1000));
    return {
      daysLeft,
      expiresAt: String(soonest.expiresAt),
      planName: String(soonest.planName || ""),
      reminderDays: parseExpiryReminderDays(await db.getSetting("expiryReminderDays")),
    };
  }),
  mySubscriptions: protectedProcedure.query(async ({ ctx }) => {
    await db.expireUserSubscriptions();
    return db.listUserSubscriptions(ctx.user.id, { visibility: "user" });
  }),
  assign: adminProcedure
    .input(z.object({
      userId: z.number().int().positive(),
      planId: z.number().int().positive(),
      durationDays: z.union([z.literal(0), z.literal(30), z.literal(90), z.literal(180)]).optional(),
    }))
    .mutation(async ({ input }) => {
      const plan = await db.getSubscriptionPlanById(input.planId);
      if (!plan) throw new Error("套餐不存在");
      const overrideDurationDays = input.durationDays !== undefined && Number(plan.durationDays) === 30
        ? input.durationDays
        : null;
      const result = await db.applySubscriptionToUser(input.userId, input.planId, "admin", null, undefined, overrideDurationDays);
      await refreshUserForwardEndpoints(input.userId, "plan-assigned");
      appendPanelLog("info", `[Plan] assigned user=${input.userId} plan=${input.planId} duration=${overrideDurationDays ?? plan.durationDays} ports=${result.portRangeStart}-${result.portRangeEnd}`);
      return result;
    }),
  cancelSubscription: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const subscription = await db.cancelUserSubscription(input.id);
      await refreshUserForwardEndpoints(subscription.userId, "subscription-cancelled");
      return { success: true };
    }),
  deleteCancelledSubscription: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const result = await db.dismissCancelledUserSubscription({
        id: input.id,
        viewerUserId: ctx.user.id,
        isAdmin: ctx.user.role === "admin",
      });
      appendPanelLog("info", `[Plan] dismissed cancelled subscription=${result.id} user=${result.userId} operator=${ctx.user.id}`);
      return { success: true };
    }),
  extendSubscription: adminProcedure
    .input(z.object({
      id: z.number().int().positive(),
      days: z.number().int().min(1).max(3650).optional(),
      expiresAt: z.string().nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const hasExpiresAtInput = Object.prototype.hasOwnProperty.call(input, "expiresAt");
      const result = hasExpiresAtInput
        ? await db.setUserSubscriptionExpiresAt(input.id, input.expiresAt ? new Date(input.expiresAt) : null)
        : await db.extendUserSubscription(input.id, input.days || 0);
      await refreshUserForwardEndpoints(result.userId, hasExpiresAtInput ? "subscription-expiry-updated" : "subscription-extended");
      appendPanelLog("info", hasExpiresAtInput
        ? `[Plan] updated subscription expiry subscription=${input.id} user=${result.userId} expiresAt=${input.expiresAt || "permanent"} operator=${ctx.user.id}`
        : `[Plan] extended subscription=${input.id} user=${result.userId} days=${input.days} operator=${ctx.user.id}`);
      return result;
    }),
});
