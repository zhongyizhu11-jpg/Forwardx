/**
 * 落地节点的在线状态。
 *
 * 数据来源是中转机 Agent 对转发目标做的 tcping —— 一条转发的目标地址就是它绑定的
 * 那个落地节点的 host:port，所以规则的探测结果直接就是「这个落地通不通」。
 *
 * 有两件事必须讲清楚，否则这个小绿点会骗人：
 *
 * 1. 探测是**从中转机发出**的，不是从你的客户端。中转机连得上不等于你连得上
 *    （你那一段可能被墙），反过来也一样。
 * 2. 没有转发绑定的节点没有任何东西在探它，只能是「未知」。装在这里显示成
 *    「离线」是错的 —— 那会把一个好端端的节点标成红的。
 */

import { LINK_PROBE_FRESH_MS, LINK_PROBE_MAX_FUTURE_SKEW_MS } from "./linkProbePolicy";

/**
 * 节点流量的统计窗口。
 *
 * 明确写死而不是依赖 metrics 的默认值：traffic_stats 只保留 72 小时，再往前的
 * 明细已经被清掉了，查更长的窗口只会得到一个悄悄偏小的数。界面上的「近 72 小时」
 * 和这里查的窗口必须是同一个常量，否则改一边就会变成一句假话。
 */
export const PROXY_NODE_TRAFFIC_WINDOW_HOURS = 72;

export type ProxyNodeHealthState = "online" | "offline" | "unknown";

/** 一条转发规则上最近一次探测的结果。 */
export type ProxyNodeProbeSample = {
  /** 可达时的往返延迟；超时或没测到时为 null。 */
  latencyMs: number | null;
  isTimeout: boolean;
  /** 探测时间，epoch 毫秒；0 表示没有探测记录。 */
  at: number;
};

export type ProxyNodeHealth = {
  state: ProxyNodeHealthState;
  /** 在线时给出最快那条中转的延迟，其余情况为 null。 */
  latencyMs: number | null;
  /** 鼠标悬停时的说明，直接可显示。 */
  title: string;
};

/** 探测是不是还算数。太旧的结果不能拿来标颜色 —— 半小时前通不等于现在通。 */
export function isProbeFresh(at: number, now = Date.now()): boolean {
  if (!Number.isFinite(at) || at <= 0) return false;
  // 允许一点点未来时间：中转机和面板的时钟不会完全一致。
  if (at > now + LINK_PROBE_MAX_FUTURE_SKEW_MS) return false;
  return now - at <= LINK_PROBE_FRESH_MS;
}

/**
 * 把一个落地节点身上所有转发的探测结果并成一个状态。
 *
 * 判定是「任一可达即在线」：同一个落地被三台中转指向时，只要有一台连得上，
 * 这个落地本身就是活的 —— 另外两台连不上是那两条线路的问题，不是落地的问题。
 * 按「全部可达才算在线」去判，机房抖一下就会把落地误标成挂了。
 */
export function resolveProxyNodeHealth(
  samples: readonly ProxyNodeProbeSample[],
  now = Date.now(),
): ProxyNodeHealth {
  const fresh = samples.filter((sample) => isProbeFresh(sample.at, now));
  if (fresh.length === 0) {
    return { state: "unknown", latencyMs: null, title: "暂无探测结果" };
  }

  const reachable = fresh.filter((sample) => !sample.isTimeout
    && sample.latencyMs !== null
    && Number.isFinite(sample.latencyMs)
    && (sample.latencyMs as number) >= 0);

  if (reachable.length === 0) {
    const label = fresh.length > 1 ? `${fresh.length} 条中转探测均超时` : "最近一次探测超时";
    return { state: "offline", latencyMs: null, title: label };
  }

  const best = Math.min(...reachable.map((sample) => Number(sample.latencyMs)));
  const rounded = Math.round(best);
  const label = fresh.length > reachable.length
    ? `可达（最快 ${rounded}ms，${fresh.length - reachable.length} 条中转探测超时）`
    : `可达（${rounded}ms）`;
  return { state: "online", latencyMs: rounded, title: label };
}
