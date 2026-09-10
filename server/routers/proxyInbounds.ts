/**
 * 落地入站的接口。
 *
 * 与 proxySubscriptions.ts 的分工：那边管「客户端订阅」（粘链接进来的节点、
 * 订阅令牌），这边管「面板自己在主机上开节点」。两者共用同一个权限开关 ——
 * 开落地节点的人一定也要能看订阅，否则开出来的东西自己拿不到。
 *
 * 凭据一律由服务端生成，不让前端传：REALITY 私钥、UUID、密码这些一旦经过浏览器
 * 就多了一条泄漏路径，而用户也没有理由要自己指定它们。
 */

import { z } from "zod";

import { pushAgentRefresh } from "../agentEvents";
import { protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import {
  createEmptyProxyInbound,
  proxyInboundSecurities,
  proxyInboundTransports,
  PROXY_INBOUND_PROTOCOLS,
  PROXY_INBOUND_SECURITIES,
  PROXY_INBOUND_SNELL_DEFAULT_VERSION,
  PROXY_INBOUND_SNELL_VERSIONS,
  validateProxyInbound,
  type ProxyInbound,
  type ProxyInboundProtocol,
} from "../../shared/proxyInbound";
import { PROXY_NODE_TRANSPORTS } from "../../shared/proxyNode";
import {
  generateProxyInboundPassword,
  generateProxyInboundPsk,
  generateProxyInboundUuid,
  generateRealityKeyPair,
  generateRealityShortId,
} from "../proxyRealityKeys";

/**
 * REALITY 要偷的默认握手域名。
 *
 * 挑的标准是「随处可达、TLS 1.3、证书链正常、且本身流量就大」—— 偷一个冷门站点
 * 反而显眼。用户可以改。
 */
const DEFAULT_REALITY_SERVER_NAME = "dl.google.com";

/** Shadowsocks 默认用 SS2022：AEAD 那几个老加密方式已经有已知的主动探测手段。 */
const DEFAULT_SHADOWSOCKS_METHOD = "2022-blake3-aes-128-gcm";

/** SS2022 的密码是定长的 base64，长度跟着加密方式的密钥长度走。 */
const SHADOWSOCKS_2022_KEY_BYTES: Record<string, number> = {
  "2022-blake3-aes-128-gcm": 16,
  "2022-blake3-aes-256-gcm": 32,
  "2022-blake3-chacha20-poly1305": 32,
};

async function assertAllowed(ctx: any) {
  if (ctx.user.role === "admin") return;
  const user = await db.getUserById(ctx.user.id);
  if (!user?.allowProxySubscription) throw new Error("当前账号没有客户端订阅权限，请联系管理员开通");
}

async function assertOwnedInbound(id: number, ctx: any) {
  const inbound = await db.getProxyInboundById(id);
  if (!inbound) throw new Error("落地节点不存在");
  if (ctx.user.role !== "admin" && inbound.userId !== ctx.user.id) throw new Error("无权操作该落地节点");
  return inbound;
}

/**
 * 落地节点只能开在装了 Agent 的主机上 —— 面板要靠 Agent 把配置推下去。
 * 租来的线路机上装不了 Agent，那种落地仍然走「粘链接」那条路。
 */
async function assertUsableHost(hostId: number, ctx: any) {
  const host = await db.getHostById(hostId);
  if (!host) throw new Error("主机不存在");
  if (ctx.user.role !== "admin") {
    // 用有效授权而不是直接授权：套餐附带的主机也算数。
    const allowed = await db.getUserEffectiveAllowedHostIds(ctx.user.id);
    if (!allowed.includes(hostId)) throw new Error("无权在该主机上开落地节点");
  }
  return host;
}

/** 按协议与安全层补齐这一份入站需要的随机凭据。 */
function fillGeneratedCredentials(inbound: ProxyInbound): ProxyInbound {
  const filled = { ...inbound };
  if (filled.protocol === "vless" || filled.protocol === "vmess" || filled.protocol === "tuic") {
    filled.uuid = filled.uuid || generateProxyInboundUuid();
  }
  if (filled.protocol === "shadowsocks") {
    filled.method = filled.method || DEFAULT_SHADOWSOCKS_METHOD;
    const bytes = SHADOWSOCKS_2022_KEY_BYTES[filled.method];
    // SS2022 的密码必须是定长 base64；长度不对 sing-box 会整份拒绝加载。
    filled.password = filled.password || (bytes ? generateProxyInboundPsk(bytes) : generateProxyInboundPassword());
  } else if (filled.protocol === "anytls" || filled.protocol === "snell") {
    filled.password = filled.password || generateProxyInboundPsk(16);
  } else if (filled.protocol !== "vless" && filled.protocol !== "vmess") {
    filled.password = filled.password || generateProxyInboundPassword();
  }
  if (filled.protocol === "snell" && !filled.snellVersion) {
    filled.snellVersion = PROXY_INBOUND_SNELL_DEFAULT_VERSION;
  }
  if (filled.security === "reality") {
    filled.serverName = filled.serverName || DEFAULT_REALITY_SERVER_NAME;
    if (!filled.realityPrivateKey || !filled.realityPublicKey) {
      const pair = generateRealityKeyPair();
      filled.realityPrivateKey = pair.privateKey;
      filled.realityPublicKey = pair.publicKey;
    }
    filled.realityShortId = filled.realityShortId || generateRealityShortId();
  }
  return filled;
}

/**
 * 保存后同步派生节点，并催这台主机马上重算一次下发。
 *
 * 不催也会生效 —— 下一次心跳就会重算；催一下只是把「改完到生效」从几十秒压到
 * 立刻，用户不至于以为没保存上。下发本身是按主机整体重算的：一台机器上所有
 * 启用中的入站合成一份 sing-box 配置。
 */
async function applyInbound(inboundId: number, hostId: number) {
  await db.syncProxyNodeFromInbound(inboundId);
  pushAgentRefresh(hostId, `proxy-inbound-${inboundId}`, { urgent: true });
}

const inboundInput = z.object({
  hostId: z.number().int().positive(),
  name: z.string().trim().min(1).max(64),
  remark: z.string().trim().max(200).optional(),
  protocol: z.enum(PROXY_INBOUND_PROTOCOLS),
  port: z.number().int().min(1).max(65535),
  transport: z.enum(PROXY_NODE_TRANSPORTS).optional(),
  security: z.enum(PROXY_INBOUND_SECURITIES).optional(),
  serverName: z.string().trim().max(253).optional(),
  realityDest: z.string().trim().max(300).optional(),
  path: z.string().trim().max(200).optional(),
  host: z.string().trim().max(253).optional(),
  certPath: z.string().trim().max(300).optional(),
  keyPath: z.string().trim().max(300).optional(),
  flow: z.string().trim().max(64).optional(),
  method: z.string().trim().max(64).optional(),
  obfs: z.string().trim().max(32).optional(),
  obfsPassword: z.string().trim().max(128).optional(),
  upMbps: z.number().int().min(0).max(100000).optional(),
  downMbps: z.number().int().min(0).max(100000).optional(),
  congestionControl: z.string().trim().max(32).optional(),
  snellVersion: z.number().int().optional(),
  snellMode: z.string().trim().max(32).optional(),
  isEnabled: z.boolean().optional(),
});

type InboundInput = z.infer<typeof inboundInput>;

/** 把接口入参并进入站模型，缺省值按协议推导。 */
function mergeInbound(base: ProxyInbound, input: Partial<InboundInput>): ProxyInbound {
  const merged: ProxyInbound = { ...base };
  if (input.protocol !== undefined) merged.protocol = input.protocol as ProxyInboundProtocol;
  if (input.name !== undefined) merged.name = input.name;
  if (input.port !== undefined) merged.port = input.port;
  if (input.transport !== undefined) merged.transport = input.transport;
  if (input.security !== undefined) merged.security = input.security;
  if (input.serverName !== undefined) merged.serverName = input.serverName;
  if (input.realityDest !== undefined) merged.realityDest = input.realityDest;
  if (input.path !== undefined) merged.path = input.path;
  if (input.host !== undefined) merged.host = input.host;
  if (input.certPath !== undefined) merged.certPath = input.certPath;
  if (input.keyPath !== undefined) merged.keyPath = input.keyPath;
  if (input.flow !== undefined) merged.flow = input.flow;
  if (input.method !== undefined) merged.method = input.method;
  if (input.obfs !== undefined) merged.obfs = input.obfs.toLowerCase();
  if (input.obfsPassword !== undefined) merged.obfsPassword = input.obfsPassword;
  if (input.upMbps !== undefined) merged.upMbps = input.upMbps;
  if (input.downMbps !== undefined) merged.downMbps = input.downMbps;
  if (input.congestionControl !== undefined) merged.congestionControl = input.congestionControl;
  if (input.snellVersion !== undefined) merged.snellVersion = input.snellVersion;
  if (input.snellMode !== undefined) merged.snellMode = input.snellMode;

  // 换协议时把不适用的传输与安全层收敛回该协议允许的第一项，
  // 否则会留下一个「VLESS 时选了 ws，改成 Hysteria2 后 ws 还在」的非法组合。
  const transports = proxyInboundTransports(merged.protocol);
  if (!transports.includes(merged.transport)) merged.transport = transports[0];
  const securities = proxyInboundSecurities(merged.protocol);
  if (!securities.includes(merged.security)) merged.security = securities[0];
  return merged;
}

export const proxyInboundsRouter = router({
  /** 这个协议能选哪些传输与安全层，以及有没有默认值。UI 用它收窄下拉。 */
  options: protectedProcedure.query(async () => ({
    protocols: PROXY_INBOUND_PROTOCOLS.map((protocol) => ({
      protocol,
      transports: proxyInboundTransports(protocol),
      securities: proxyInboundSecurities(protocol),
    })),
    snellVersions: [...PROXY_INBOUND_SNELL_VERSIONS],
    defaultRealityServerName: DEFAULT_REALITY_SERVER_NAME,
    defaultShadowsocksMethod: DEFAULT_SHADOWSOCKS_METHOD,
  })),

  list: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role !== "admin") {
      const user = await db.getUserById(ctx.user.id);
      if (!user?.allowProxySubscription) return [];
    }
    const rows = await db.getProxyInboundsByUser(ctx.user.id);
    // 私钥不出接口：前端没有任何用得上它的地方，多送一次就多一条泄漏路径。
    return rows.map((row: any) => ({ ...row, realityPrivateKey: undefined }));
  }),

  create: protectedProcedure
    .input(inboundInput)
    .mutation(async ({ ctx, input }) => {
      await assertAllowed(ctx);
      await assertUsableHost(input.hostId, ctx);

      const conflict = await db.findProxyInboundPortConflict(input.hostId, input.port);
      if (conflict) throw new Error(`该主机的 ${input.port} 端口已被落地节点「${conflict.name}」占用`);

      const inbound = fillGeneratedCredentials(mergeInbound(createEmptyProxyInbound(), input));
      const reason = validateProxyInbound(inbound);
      if (reason) throw new Error(reason);

      const id = await db.createProxyInbound({
        userId: ctx.user.id,
        hostId: input.hostId,
        name: input.name,
        remark: input.remark || null,
        isEnabled: input.isEnabled ?? true,
        ...db.proxyInboundToRow(inbound),
      } as any);
      await applyInbound(id, input.hostId);
      return { id };
    }),

  update: protectedProcedure
    .input(inboundInput.partial().extend({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await assertAllowed(ctx);
      const row = await assertOwnedInbound(input.id, ctx);
      const hostId = input.hostId ?? Number(row.hostId);
      if (input.hostId !== undefined) await assertUsableHost(input.hostId, ctx);

      const port = input.port ?? Number(row.port);
      const conflict = await db.findProxyInboundPortConflict(hostId, port, input.id);
      if (conflict) throw new Error(`该主机的 ${port} 端口已被落地节点「${conflict.name}」占用`);

      const merged = mergeInbound(db.proxyInboundFromRow(row as any), input);
      /**
       * 换了协议或安全层就重新生成凭据。
       *
       * 沿用旧凭据看着更"省事"，实际是错的：REALITY 的密钥对与 TLS 证书不通用，
       * Shadowsocks 换加密方式后密码长度要求也变了 —— 留着旧值只会得到一份
       * sing-box 拒绝加载的配置。
       */
      const changedShape = (input.protocol !== undefined && input.protocol !== row.protocol)
        || (input.security !== undefined && input.security !== row.security)
        || (input.method !== undefined && input.method !== row.method);
      const reset = changedShape
        ? { ...merged, uuid: "", password: "", realityPrivateKey: "", realityPublicKey: "", realityShortId: "" }
        : merged;
      const inbound = fillGeneratedCredentials(reset);

      const reason = validateProxyInbound(inbound);
      if (reason) throw new Error(reason);

      await db.updateProxyInbound(input.id, {
        hostId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.remark !== undefined ? { remark: input.remark || null } : {}),
        ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
        ...db.proxyInboundToRow(inbound),
      } as any);
      await applyInbound(input.id, hostId);
      // 换过主机时旧主机也要重推一遍，否则那边的配置里还留着这个入站。
      if (input.hostId !== undefined && Number(row.hostId) !== hostId) {
        pushAgentRefresh(Number(row.hostId), `proxy-inbound-moved-${input.id}`, { urgent: true });
      }
      return { success: true };
    }),

  /** 重新生成凭据。用于疑似泄漏时换掉，而不必删了重建。 */
  rotate: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await assertAllowed(ctx);
      const row = await assertOwnedInbound(input.id, ctx);
      const current = db.proxyInboundFromRow(row as any);
      const inbound = fillGeneratedCredentials({
        ...current,
        uuid: "",
        password: "",
        realityPrivateKey: "",
        realityPublicKey: "",
        realityShortId: "",
      });
      await db.updateProxyInbound(input.id, db.proxyInboundToRow(inbound) as any);
      await applyInbound(input.id, Number(row.hostId));
      // 换了凭据，旧订阅立刻失效 —— 这是预期行为，界面上要讲清楚。
      return { success: true };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await assertAllowed(ctx);
      const row = await assertOwnedInbound(input.id, ctx);
      const result = await db.deleteProxyInbound(input.id);
      pushAgentRefresh(Number(row.hostId), `proxy-inbound-deleted-${input.id}`, { urgent: true });
      return { success: true, ...result };
    }),
});
