/**
 * 落地入站的流量计数怎么接进现有计费。
 *
 * 背景：整条计费链路是按 ruleId 组织的 —— Agent 报 `{ruleId, bytesIn, bytesOut}`，
 * 面板拿 ruleId 查转发规则、查出用户、扣套餐。而落地入站不是转发规则，没有 ruleId。
 *
 * 做法：面板在下发的 runningRules 里为每个启用中的入站放一条「只计数」的条目。
 * 这条路能走通靠两个既有事实：
 *
 *   1. Agent 的 runningRules 只驱动「写状态 + 装计数链」，转发器是由 actions 启动的。
 *      所以放进 runningRules 但不发 apply 动作，就只会计数、不会真去转发。
 *   2. 非 iptables/nftables/forwardx 的转发方式走 countingRuleProcess 模式，装计数链
 *      只需要监听端口和协议，不需要目标地址 —— 这正好是「一个本地监听端口」的形状。
 *
 * 因此这一步不需要改 Agent，已装的 Agent 直接就能报上来。
 *
 * ruleId 用一个大的正数基数偏移，而不是负数：Agent 侧有若干处按 ruleId 做键或做
 * 判断，负数虽然大概率也能跑，但那是赌运气；偏移则完全落在既有的正整数假设里。
 */

/**
 * 入站流量上报用的 ruleId 基数。
 *
 * 真实转发规则的 id 是自增整数，实际部署里远达不到十亿量级；而 int32 的上限是
 * 约 21.47 亿，基数加上入站 id 仍在范围内。两侧都留了断言，真撞上时宁可当场报错
 * 也不要把落地流量算到某条转发规则头上。
 */
export const PROXY_INBOUND_TRAFFIC_RULE_ID_BASE = 1_000_000_000;

/** Agent 日志里能看出这条是干什么的；同时保证落进 countingRuleProcess 模式。 */
export const PROXY_INBOUND_TRAFFIC_FORWARD_TYPE = "proxy-inbound";

export function proxyInboundTrafficRuleId(inboundId: number): number {
  const id = Number(inboundId);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`落地入站 id 不合法: ${inboundId}`);
  if (id >= PROXY_INBOUND_TRAFFIC_RULE_ID_BASE) {
    throw new Error(`落地入站 id 超出可编码范围: ${inboundId}`);
  }
  return PROXY_INBOUND_TRAFFIC_RULE_ID_BASE + id;
}

/** 这个上报的 ruleId 是落地入站吗？ */
export function isProxyInboundTrafficRuleId(ruleId: unknown): boolean {
  const id = Number(ruleId);
  return Number.isInteger(id) && id > PROXY_INBOUND_TRAFFIC_RULE_ID_BASE;
}

/** 从上报的 ruleId 还原出入站 id；不是入站时返回 0。 */
export function proxyInboundIdFromTrafficRuleId(ruleId: unknown): number {
  if (!isProxyInboundTrafficRuleId(ruleId)) return 0;
  return Number(ruleId) - PROXY_INBOUND_TRAFFIC_RULE_ID_BASE;
}

/**
 * 这个协议的落地端口该按哪种协议计数。
 *
 * Hysteria2 与 TUIC 跑在 QUIC 上，全程只有 UDP 包；其余协议是 TCP，客户端的 UDP
 * 转发也裹在那条 TCP 流里，按 tcp 算就是全量。算错的后果是漏计一半流量。
 */
export function proxyInboundTrafficProtocol(protocol: unknown): "tcp" | "udp" {
  const raw = String(protocol ?? "").trim().toLowerCase();
  return raw === "hysteria2" || raw === "tuic" ? "udp" : "tcp";
}
