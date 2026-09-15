// Keep online-state calculations consistent across host, token, tunnel and
// dashboard queries. The UI TTL is intentionally more tolerant than the
// dedicated failover liveness deadlines.
export { HOST_ONLINE_TTL_MS } from "../shared/hostHeartbeat";
import { HOST_ONLINE_TTL_MS } from "../shared/hostHeartbeat";
import { isAgentFastLivenessConfirmedOffline } from "./agentFastLiveness";

/**
 * 这台机器的心跳还算不算新鲜。
 *
 * 主机仓库和 Token 仓库原来各存一份（`isFreshHostHeartbeat` / `isFreshHeartbeat`），
 * 判的是同一件事：库里那个 isOnline 是上一次写入的结论，心跳停了它不会自己变，
 * 所以读出来时还要拿时间戳再验一次。两份漂了就会出现「主机页说在线、Token 页
 * 说离线」这种谁也说不清的事，而这两页说的本来就是同一台机器。
 */
export function isFreshHostHeartbeat(lastHeartbeat: unknown) {
  if (!lastHeartbeat) return false;
  const time = new Date(lastHeartbeat as any).getTime();
  return Number.isFinite(time) && Date.now() - time <= HOST_ONLINE_TTL_MS;
}

/**
 * 这台机器现在算不算在线。
 *
 * 三个条件缺一不可，而它们原来在两处各写一遍：仓储读出来时折算一次
 * （withComputedOnline），Telegram 状态通知那边又写一次（isHostStatusOnline）。
 * 判的是同一件事，漂了就会出现「列表上是绿的、机器人刚发过掉线通知」。
 *
 * - `isOnline`：上一次写库时的结论。
 * - 心跳还新鲜：那个结论会过期，而它不会自己变。
 * - 快速失联没有确认掉线：Agent 那条实时通道已经判定它没了，这一票最新。
 */
export function isHostConsideredOnline(host: {
  id?: unknown;
  isOnline?: unknown;
  lastHeartbeat?: unknown;
} | null | undefined): boolean {
  if (!host) return false;
  return !!host.isOnline
    && isFreshHostHeartbeat(host.lastHeartbeat)
    && !isAgentFastLivenessConfirmedOffline(host.id as any);
}
