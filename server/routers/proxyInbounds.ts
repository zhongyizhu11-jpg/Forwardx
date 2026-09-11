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
  PROXY_INBOUND_SHADOWSOCKS_METHODS,
  PROXY_INBOUND_SHADOWSOCKS_KEY_BYTES,
  PROXY_INBOUND_SHADOWSOCKS_DEFAULT_METHOD,
  isProxyInboundShadowsocksMethod,
  proxyInboundSupportsMultiUser,
  proxyInboundUserCredentialKinds,
  validateProxyInbound,
  type ProxyInboundUser,
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

/** 给一个用户补齐它这个协议需要的凭据。已有值不动 —— 编辑时不该把别人的凭据换掉。 */
function fillUserCredentials(user: ProxyInboundUser, protocol: ProxyInbound["protocol"]): ProxyInboundUser {
  const kinds = proxyInboundUserCredentialKinds(protocol);
  return {
    ...user,
    uuid: kinds.includes("uuid") ? (user.uuid || generateProxyInboundUuid()) : "",
    password: kinds.includes("password") ? (user.password || generateProxyInboundPassword()) : "",
  };
}

/**
 * 解析这个入站该归谁，并确认那个人拿得到它。
 *
 * 关键的一条：被指定的人必须有客户端订阅权限。没有的话入站会正常建起来、流量也
 * 会照扣，但他在面板上看不到节点、也拉不到订阅 —— 一个「建好了却用不上」的节点，
 * 而管理员从界面上看不出哪里不对。所以在这里当场拦住并说清要去开什么。
 */
async function resolveOwnerId(ctx: any, requested?: number): Promise<number> {
  const ownerId = Number(requested || 0);
  if (!ownerId || ownerId === ctx.user.id) return ctx.user.id;
  if (ctx.user.role !== "admin") throw new Error("只有管理员能把落地节点开给其他用户");
  const owner = await db.getUserById(ownerId);
  if (!owner) throw new Error("指定的用户不存在");
  if (!owner.allowProxySubscription) {
    throw new Error(`用户「${owner.username}」没有客户端订阅权限，开给他也拿不到节点 —— 请先在「用户管理」里开通`);
  }
  return ownerId;
}

/** 按协议与安全层补齐这一份入站需要的随机凭据。 */
function fillGeneratedCredentials(inbound: ProxyInbound): ProxyInbound {
  const filled = { ...inbound };
  if (proxyInboundSupportsMultiUser(filled.protocol)) {
    // 一个用户都没有时补一个默认的：新建时用户不必先去想「给谁用」。
    const users = filled.users.length > 0 ? filled.users : [{ id: 0, name: "默认", uuid: "", password: "" }];
    filled.users = users.map((user) => fillUserCredentials(user, filled.protocol));
    // 多用户协议的凭据只在用户身上，入站行上的那两列不再参与鉴权，清掉免得看着像还有用。
    filled.uuid = "";
    filled.password = "";
  } else {
    filled.users = [];
  }
  if (filled.protocol === "shadowsocks") {
    filled.method = isProxyInboundShadowsocksMethod(filled.method)
      ? filled.method
      : PROXY_INBOUND_SHADOWSOCKS_DEFAULT_METHOD;
    const bytes = PROXY_INBOUND_SHADOWSOCKS_KEY_BYTES[filled.method as keyof typeof PROXY_INBOUND_SHADOWSOCKS_KEY_BYTES];
    // SS2022 的密码必须是定长 base64；长度不对 sing-box 会整份拒绝加载。
    filled.password = filled.password || (bytes ? generateProxyInboundPsk(bytes) : generateProxyInboundPassword());
  } else if (filled.protocol === "snell") {
    filled.password = filled.password || generateProxyInboundPsk(16);
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
  /**
   * 这个入站归谁。只有管理员能指定别人 —— 这是「把一台机器上的多个端口分租给
   * 不同用户」的关键：归属决定了节点进谁的订阅、流量扣谁的套餐。
   * 不传就是操作者自己。
   */
  userId: z.number().int().positive().optional(),
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
  acmeEmail: z.string().trim().max(200).optional(),
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
  /**
   * 入站上的用户。只有多用户协议用得上，且只收 id 与 name ——
   * 凭据一律服务端生成，不让前端指定（经过浏览器就多一条泄漏路径）。
   * 不传表示不改动现有用户；传空数组会被当成「补一个默认用户」。
   */
  users: z.array(z.object({
    id: z.number().int().nonnegative().default(0),
    name: z.string().trim().max(64),
  })).max(200).optional(),
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
  if (input.acmeEmail !== undefined) merged.acmeEmail = input.acmeEmail;
  if (input.flow !== undefined) merged.flow = input.flow;
  if (input.method !== undefined) merged.method = input.method;
  if (input.obfs !== undefined) merged.obfs = input.obfs.toLowerCase();
  if (input.obfsPassword !== undefined) merged.obfsPassword = input.obfsPassword;
  if (input.upMbps !== undefined) merged.upMbps = input.upMbps;
  if (input.downMbps !== undefined) merged.downMbps = input.downMbps;
  if (input.congestionControl !== undefined) merged.congestionControl = input.congestionControl;
  if (input.snellVersion !== undefined) merged.snellVersion = input.snellVersion;
  if (input.snellMode !== undefined) merged.snellMode = input.snellMode;
  if (input.users !== undefined) {
    /**
     * 按 id 对上已有用户，把凭据带过来 —— 前端不传凭据，这里若不保留，
     * 每次改个名字都会给所有人换一遍凭据，客户端全体掉线。
     */
    const byId = new Map(base.users.map((user) => [user.id, user]));
    merged.users = input.users.map((item) => {
      const current = item.id > 0 ? byId.get(item.id) : undefined;
      return {
        id: current ? current.id : 0,
        name: item.name,
        uuid: current?.uuid || "",
        password: current?.password || "",
      };
    });
  }

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
      multiUser: proxyInboundSupportsMultiUser(protocol),
    })),
    snellVersions: [...PROXY_INBOUND_SNELL_VERSIONS],
    defaultRealityServerName: DEFAULT_REALITY_SERVER_NAME,
    shadowsocksMethods: [...PROXY_INBOUND_SHADOWSOCKS_METHODS],
    defaultShadowsocksMethod: PROXY_INBOUND_SHADOWSOCKS_DEFAULT_METHOD,
  })),

  list: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role !== "admin") {
      const user = await db.getUserById(ctx.user.id);
      if (!user?.allowProxySubscription) return [];
    }
    // 管理员看全量：分租场景里要能看到一台机器上所有端口分给了谁。
    const rows = ctx.user.role === "admin"
      ? await db.getAllProxyInbounds()
      : await db.getProxyInboundsByUser(ctx.user.id);
    return Promise.all(rows.map(async (row: any) => ({
      ...row,
      // 私钥不出接口：前端没有任何用得上它的地方，多送一次就多一条泄漏路径。
      realityPrivateKey: undefined,
      // 同理用户凭据也不出去，只给 id 和名字，够界面显示和编辑了。
      users: (await db.getProxyInboundUsers(Number(row.id))).map((user) => ({ id: user.id, name: user.name })),
    })));
  }),

  create: protectedProcedure
    .input(inboundInput)
    .mutation(async ({ ctx, input }) => {
      await assertAllowed(ctx);
      await assertUsableHost(input.hostId, ctx);
      const ownerId = await resolveOwnerId(ctx, input.userId);

      const conflict = await db.findProxyInboundPortConflict(input.hostId, input.port);
      if (conflict) throw new Error(`该主机的 ${input.port} 端口已被落地节点「${conflict.name}」占用`);

      const inbound = fillGeneratedCredentials(mergeInbound(createEmptyProxyInbound(), input));
      const reason = validateProxyInbound(inbound);
      if (reason) throw new Error(reason);

      const id = await db.createProxyInbound({
        userId: ownerId,
        hostId: input.hostId,
        name: input.name,
        remark: input.remark || null,
        isEnabled: input.isEnabled ?? true,
        ...db.proxyInboundToRow(inbound),
      } as any);
      await db.replaceProxyInboundUsers(Number(id), inbound.users);
      await applyInbound(Number(id), input.hostId);
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

      const loaded = await db.loadProxyInbound(input.id);
      if (!loaded) throw new Error("落地节点不存在");
      const merged = mergeInbound(loaded, input);
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

      /**
       * 换归属时派生节点会跟着换主人（syncProxyNodeFromInbound 按入站行的 userId
       * 写），所以旧主人的订阅里那条会消失、新主人的订阅里出现 —— 这是预期行为，
       * 但要提醒：旧主人已经导入的客户端会失去这个节点。
       */
      const ownerId = input.userId !== undefined
        ? await resolveOwnerId(ctx, input.userId)
        : Number(row.userId);

      await db.updateProxyInbound(input.id, {
        hostId,
        userId: ownerId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.remark !== undefined ? { remark: input.remark || null } : {}),
        ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
        ...db.proxyInboundToRow(inbound),
      } as any);
      await db.replaceProxyInboundUsers(input.id, inbound.users);
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
      const current = await db.loadProxyInbound(input.id);
      if (!current) throw new Error("落地节点不存在");
      const inbound = fillGeneratedCredentials({
        ...current,
        uuid: "",
        password: "",
        // 每个用户的凭据都换掉，但保留 id 与名字 —— 派生节点要靠 id 对齐，
        // 换 id 会让订阅里的节点被删掉重建，转发规则上的绑定跟着丢。
        users: current.users.map((user) => ({ ...user, uuid: "", password: "" })),
        realityPrivateKey: "",
        realityPublicKey: "",
        realityShortId: "",
      });
      await db.updateProxyInbound(input.id, db.proxyInboundToRow(inbound) as any);
      await db.replaceProxyInboundUsers(input.id, inbound.users);
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
