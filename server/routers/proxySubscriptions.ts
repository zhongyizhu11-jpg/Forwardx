import { nanoid } from "nanoid";
import { z } from "zod";

import { protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { parseProxyNodeLink, type ProxyNode } from "../../shared/proxyNode";
import { PROXY_SUBSCRIPTION_FORMATS } from "../../shared/proxySubscription";
import { PROXY_RULE_PRESETS } from "../../shared/proxyRuleset";
import {
  PROXY_NODE_AUTO_GROUPS,
  PROXY_SUBSCRIPTION_SKIP_LABELS,
} from "../../shared/proxySubscriptionPlan";

/**
 * 订阅令牌够长才安全：地址里带着全部节点凭据，一旦可猜就等于把节点送人。
 */
const SUBSCRIPTION_TOKEN_LENGTH = 40;

function nodeToRow(node: ProxyNode, sourceLink: string) {
  return {
    protocol: node.protocol,
    sourceLink: sourceLink || null,
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
  };
}

async function assertOwnedNode(id: number, ctx: any) {
  const node = await db.getProxyNodeById(id);
  if (!node) throw new Error("客户端节点不存在");
  if (ctx.user.role !== "admin" && node.userId !== ctx.user.id) throw new Error("无权操作该客户端节点");
  return node;
}

async function assertOwnedRule(id: number, ctx: any) {
  const rule = await db.getForwardRuleById(id);
  if (!rule) throw new Error("转发规则不存在");
  if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) throw new Error("无权操作该转发规则");
  return rule;
}

async function assertOwnedToken(id: number, ctx: any) {
  const token = await db.getProxySubTokenById(id);
  if (!token) throw new Error("订阅链接不存在");
  if (ctx.user.role !== "admin" && token.userId !== ctx.user.id) throw new Error("无权操作该订阅链接");
  return token;
}

export const proxySubscriptionsRouter = router({
  /** 解析一条节点链接但不落库，供界面在保存前预览与报错。 */
  parseLink: protectedProcedure
    .input(z.object({ link: z.string().min(1).max(8192) }))
    .mutation(async ({ input }) => {
      const result = parseProxyNodeLink(input.link);
      if (!result.ok) return { ok: false as const, error: result.error };
      return { ok: true as const, node: result.node };
    }),

  listNodes: protectedProcedure.query(async ({ ctx }) => {
    const nodes = await db.getProxyNodesByUser(ctx.user.id);
    const counts = await Promise.all(nodes.map((node: any) => db.countRulesUsingProxyNode(node.id)));
    return nodes.map((node: any, index: number) => ({ ...node, ruleCount: counts[index] }));
  }),

  createNode: protectedProcedure
    .input(z.object({
      name: z.string().trim().min(1).max(64),
      remark: z.string().trim().max(200).optional(),
      link: z.string().min(1).max(8192),
      autoGroup: z.enum(PROXY_NODE_AUTO_GROUPS).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const parsed = parseProxyNodeLink(input.link);
      if (!parsed.ok) throw new Error(parsed.error);
      const id = await db.createProxyNode({
        userId: ctx.user.id,
        name: input.name,
        remark: input.remark || null,
        ...(input.autoGroup ? { autoGroup: input.autoGroup } : {}),
        ...nodeToRow(parsed.node, input.link),
      } as any);
      return { id };
    }),

  updateNode: protectedProcedure
    .input(z.object({
      id: z.number().int().positive(),
      name: z.string().trim().min(1).max(64).optional(),
      remark: z.string().trim().max(200).nullable().optional(),
      link: z.string().min(1).max(8192).optional(),
      isEnabled: z.boolean().optional(),
      autoGroup: z.enum(PROXY_NODE_AUTO_GROUPS).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await assertOwnedNode(input.id, ctx);
      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.remark !== undefined) data.remark = input.remark || null;
      if (input.isEnabled !== undefined) data.isEnabled = input.isEnabled;
      if (input.autoGroup !== undefined) data.autoGroup = input.autoGroup;
      if (input.link !== undefined) {
        const parsed = parseProxyNodeLink(input.link);
        if (!parsed.ok) throw new Error(parsed.error);
        Object.assign(data, nodeToRow(parsed.node, input.link));
      }
      if (Object.keys(data).length === 0) return { success: true };
      await db.updateProxyNode(input.id, data as any);
      return { success: true };
    }),

  deleteNode: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await assertOwnedNode(input.id, ctx);
      // 引用它的转发会被自动解绑，只是不再进订阅，转发本身照常运行。
      const released = await db.countRulesUsingProxyNode(input.id);
      await db.deleteProxyNode(input.id);
      return { success: true, releasedRules: released };
    }),

  /**
   * 把一条转发绑定到节点模板；proxyNodeId 传 null 表示解绑，该转发不再进订阅。
   * 转发本身的运行不受影响，这里只决定它要不要出现在客户端订阅里。
   */
  bindRule: protectedProcedure
    .input(z.object({
      ruleId: z.number().int().positive(),
      proxyNodeId: z.number().int().positive().nullable(),
      proxyNodeName: z.string().trim().max(64).nullable().optional(),
      proxyNodeVisible: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const rule = await assertOwnedRule(input.ruleId, ctx);
      if (input.proxyNodeId !== null) await assertOwnedNode(input.proxyNodeId, ctx);
      const data: Record<string, unknown> = { proxyNodeId: input.proxyNodeId };
      if (input.proxyNodeName !== undefined) data.proxyNodeName = input.proxyNodeName || null;
      if (input.proxyNodeVisible !== undefined) data.proxyNodeVisible = input.proxyNodeVisible;
      // 重新绑定时默认恢复显示，否则用户换了模板却看不到节点会以为没生效。
      if (input.proxyNodeId !== null && input.proxyNodeVisible === undefined && !rule.proxyNodeId) {
        data.proxyNodeVisible = true;
      }
      await db.updateForwardRule(input.ruleId, data as any);
      return { success: true };
    }),

  /** 单独控制某个节点是否出现在订阅里，不解除绑定。 */
  setRuleVisible: protectedProcedure
    .input(z.object({ ruleId: z.number().int().positive(), visible: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await assertOwnedRule(input.ruleId, ctx);
      await db.updateForwardRule(input.ruleId, { proxyNodeVisible: input.visible } as any);
      return { success: true };
    }),

  /** 预览订阅内容：进订阅的节点，以及每条被排除的转发和原因。 */
  preview: protectedProcedure.query(async ({ ctx }) => {
    const plan = await db.buildProxySubscriptionPlanForUser(ctx.user.id);
    const document = await db.getProxySubscriptionDocumentForUser(ctx.user.id);
    return {
      groups: document.groups
        .filter((group) => group.type !== "select")
        .map((group) => ({ name: group.name, type: group.type, members: group.members })),
      nodes: plan.entries.map((entry) => ({
        ruleId: entry.ruleId,
        templateId: entry.templateId,
        name: entry.node.name,
        protocol: entry.node.protocol,
        address: entry.node.address,
        port: entry.node.port,
      })),
      skipped: plan.skipped.map((item) => ({
        ...item,
        label: PROXY_SUBSCRIPTION_SKIP_LABELS[item.reason],
      })),
    };
  }),

  listTokens: protectedProcedure.query(async ({ ctx }) => {
    return db.getProxySubTokensByUser(ctx.user.id);
  }),

  createToken: protectedProcedure
    .input(z.object({
      name: z.string().trim().min(1).max(64),
      defaultFormat: z.enum(PROXY_SUBSCRIPTION_FORMATS).default("base64"),
      rulePreset: z.enum(PROXY_RULE_PRESETS).default("off"),
    }))
    .mutation(async ({ ctx, input }) => {
      const token = nanoid(SUBSCRIPTION_TOKEN_LENGTH);
      const id = await db.createProxySubToken({
        userId: ctx.user.id,
        name: input.name,
        token,
        defaultFormat: input.defaultFormat,
        rulePreset: input.rulePreset,
      } as any);
      return { id, token };
    }),

  updateToken: protectedProcedure
    .input(z.object({
      id: z.number().int().positive(),
      name: z.string().trim().min(1).max(64).optional(),
      defaultFormat: z.enum(PROXY_SUBSCRIPTION_FORMATS).optional(),
      rulePreset: z.enum(PROXY_RULE_PRESETS).optional(),
      isEnabled: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await assertOwnedToken(input.id, ctx);
      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.defaultFormat !== undefined) data.defaultFormat = input.defaultFormat;
      if (input.rulePreset !== undefined) data.rulePreset = input.rulePreset;
      if (input.isEnabled !== undefined) data.isEnabled = input.isEnabled;
      if (Object.keys(data).length === 0) return { success: true };
      await db.updateProxySubToken(input.id, data as any);
      return { success: true };
    }),

  /** 重置令牌：旧地址立刻失效，用于设备丢失。 */
  rotateToken: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await assertOwnedToken(input.id, ctx);
      const token = nanoid(SUBSCRIPTION_TOKEN_LENGTH);
      await db.updateProxySubToken(input.id, { token, accessCount: 0 } as any);
      return { token };
    }),

  deleteToken: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await assertOwnedToken(input.id, ctx);
      await db.deleteProxySubToken(input.id);
      return { success: true };
    }),
});
