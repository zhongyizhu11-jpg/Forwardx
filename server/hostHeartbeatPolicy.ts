// Keep online-state calculations consistent across host, token, tunnel and
// dashboard queries. The UI TTL is intentionally more tolerant than the
// dedicated failover liveness deadlines.
export { HOST_ONLINE_TTL_MS } from "../shared/hostHeartbeat";
import { HOST_ONLINE_TTL_MS } from "../shared/hostHeartbeat";

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
