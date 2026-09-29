/**
 * 换隧道后的「旧入口临时桥接」。
 *
 * 背景：规则从隧道 A（入口 Po0）换到隧道 B（入口 Po01）时，规则整条挪到新入口，旧入口上的
 * 监听随之撤掉。可客户端手里的订阅还写着 Po0:端口，不刷新订阅就一直连不上。桥接的做法是：
 * 在旧入口的老端口上临时留一条转发，把进来的流量原样转到规则**当前**的入口（地址 + 端口），
 * 等客户端陆续刷新订阅，过了设置的时长自动撤掉。
 *
 * 这里只放纯函数（编号换算、时长归一、到期文案），面板两端和测试共用。
 */

/**
 * 桥接下发给 Agent 时用的「规则 id」基数。
 *
 * 桥接不是转发规则，没有自己的规则 id；可 Agent 那一侧（状态文件、计数链、上报）处处按正整数
 * ruleId 做键，负数或 0 会被当成「没有规则」。所以和落地入站（shared/proxyInboundTraffic）
 * 一样用大基数偏移：
 *
 *   真实规则      1 .. 999_999_999          （自增 id，实际部署远到不了）
 *   落地入站计数  1_000_000_001 .. 1_999_999_999
 *   旧入口桥接    2_000_000_001 .. 2_147_483_647（int32 上限，32 位 Agent 的 int 也装得下）
 *
 * 三段互不重叠，面板收到任何按 ruleId 来的上报（运行状态、流量、探测）都能一眼分出是谁的。
 */
export const ENTRY_BRIDGE_RULE_ID_BASE = 2_000_000_000;
const ENTRY_BRIDGE_RULE_ID_MAX = 2_147_483_647;

/**
 * 桥接用哪种转发方式下发：iptables（内核 DNAT）。
 *
 * 挑它而不是 realm / socat / gost，是因为这条转发要在「任何一台曾经当过入口的机器」上都能
 * 立刻起来，而且不能碰别的规则：
 *   · 不需要额外装程序：realm、socat 得机器上有对应二进制，旧入口原来跑的是隧道，未必装过；
 *     计数链本来就用 iptables，所以它是每台 Agent 都已经具备的依赖。
 *   · TCP 和 UDP 都能转，按桥接记下的协议来，和原规则一致。
 *   · 目标是域名也行：面板在心跳里把入口地址解析成 IP 再下发，并给 Agent 挂上 DNS 观察，
 *     地址变了会像普通规则一样重下（和 iptables 规则的现有路径完全相同）。
 *   · 独立于共享运行时：gost 直连规则挤在同一个 gost 进程里，增删一条会让整份配置重载，
 *     波及这台机器上别的规则；iptables 按端口各管各的。
 *   · Agent 对 iptables 动作的「已就绪」判断会核对 DNAT 目标，规则再换到别的入口时，
 *     旧入口会把桥接改指新目标，不会因为「端口和规则 id 都没变」而跳过。
 * 已知局限：内核 DNAT 不能把 IPv4 进来的连接转给只有 IPv6 的目标（新入口是纯 IPv6 时不通）。
 */
export const ENTRY_BRIDGE_FORWARD_TYPE = "iptables" as const;

/** 设置项：换隧道后旧入口桥接保留多少小时。0 表示不建桥接。 */
export const RULE_SWITCH_BRIDGE_HOURS_SETTING = "ruleSwitchBridgeHours";
export const DEFAULT_RULE_SWITCH_BRIDGE_HOURS = 1;
export const MAX_RULE_SWITCH_BRIDGE_HOURS = 720;

export function entryBridgeRuleId(bridgeId: number): number {
  const id = Number(bridgeId);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`旧入口桥接 id 不合法: ${bridgeId}`);
  if (ENTRY_BRIDGE_RULE_ID_BASE + id > ENTRY_BRIDGE_RULE_ID_MAX) {
    throw new Error(`旧入口桥接 id 超出可编码范围: ${bridgeId}`);
  }
  return ENTRY_BRIDGE_RULE_ID_BASE + id;
}

/** 这个 ruleId 是旧入口桥接吗？ */
export function isEntryBridgeRuleId(ruleId: unknown): boolean {
  const id = Number(ruleId);
  return Number.isInteger(id) && id > ENTRY_BRIDGE_RULE_ID_BASE && id <= ENTRY_BRIDGE_RULE_ID_MAX;
}

/** 从下发用的 ruleId 还原桥接 id；不是桥接时返回 0。 */
export function entryBridgeIdFromRuleId(ruleId: unknown): number {
  if (!isEntryBridgeRuleId(ruleId)) return 0;
  return Number(ruleId) - ENTRY_BRIDGE_RULE_ID_BASE;
}

/**
 * 设置值归一成整数小时：空值或读不懂的回默认值，负数算 0（关闭），超过上限按上限。
 * 小数向下取整 —— 设置页只收整数，这里兜住手改数据库的情况。
 */
export function normalizeRuleSwitchBridgeHours(value: unknown): number {
  if (value === null || value === undefined || String(value).trim() === "") return DEFAULT_RULE_SWITCH_BRIDGE_HOURS;
  const n = Number(String(value).trim());
  if (!Number.isFinite(n)) return DEFAULT_RULE_SWITCH_BRIDGE_HOURS;
  return Math.min(MAX_RULE_SWITCH_BRIDGE_HOURS, Math.max(0, Math.floor(n)));
}

/**
 * 换入口时要在哪些旧监听主机上留桥接：旧的里面、新的不包含的那些。
 *
 * 隧道挂了入口组时，规则在组里每台机器上都监听同一个端口，客户端拿到的可能是其中任何一台；
 * 换过去以后仍然在新监听集合里的机器本来就还在听，不需要桥接（也不能建：端口要留给规则本身）。
 */
export function entryBridgeHostsForSwitch(oldListenHostIds: readonly number[], newListenHostIds: readonly number[]): number[] {
  const next = new Set(newListenHostIds.map(Number).filter((id) => Number.isInteger(id) && id > 0));
  const out: number[] = [];
  for (const raw of oldListenHostIds) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0 || next.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/** 剩余时间的中文说法：用在端口占用的报错里，「约 45 分钟」「1 小时 20 分钟」。 */
export function describeEntryBridgeRemaining(expiresAtMs: number, nowMs = Date.now()): string {
  const leftMinutes = Math.ceil((Number(expiresAtMs) - Number(nowMs)) / 60_000);
  if (!Number.isFinite(leftMinutes) || leftMinutes <= 1) return "1 分钟内";
  if (leftMinutes < 60) return `约 ${leftMinutes} 分钟`;
  const hours = Math.floor(leftMinutes / 60);
  const minutes = leftMinutes % 60;
  if (hours >= 48) return `约 ${Math.round(leftMinutes / 1440)} 天`;
  return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

/** 端口被桥接占着时给人看的报错。 */
export function entryBridgePortConflictMessage(input: { port: number; ruleId: number; expiresAtMs: number; nowMs?: number }): string {
  const remaining = describeEntryBridgeRemaining(input.expiresAtMs, input.nowMs);
  return `端口 ${input.port} 正被规则 #${input.ruleId} 换隧道后的临时桥接占用，${remaining}${remaining.endsWith("内") ? "" : "后"}自动释放`;
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

/** 规则卡片上的小字：「旧入口 Po0 仍在转发（桥接至 09-30 15:00）」。按浏览器本地时间显示。 */
export function formatEntryBridgeNote(bridge: { hostName?: unknown; hostId?: unknown; expiresAt: unknown }): string {
  const name = String(bridge.hostName ?? "").trim() || `主机 #${Number(bridge.hostId) || "-"}`;
  const at = new Date(bridge.expiresAt as any);
  const until = Number.isNaN(at.getTime())
    ? ""
    : `${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  return until ? `旧入口 ${name} 仍在转发（桥接至 ${until}）` : `旧入口 ${name} 仍在转发`;
}
