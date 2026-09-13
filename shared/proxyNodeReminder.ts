import { PROXY_NODE_TRAFFIC_WARN_PERCENT, proxyNodeQuotaState, type ProxyNodeQuotaState } from "./proxyNodeQuota";

/**
 * 落地节点的流量提醒。
 *
 * 节点上那个「总流量」原来只是个仪表盘：填了 500G，用到 700G 也照常服务，界面上除了
 * 一个红色小图标什么都不会发生。而这个数字通常来自机房 —— 跑超之后是**机房**把机器
 * 停掉，客户端里这条线路直接断，商家往往在客户找上门时才知道。
 *
 * 所以不做硬上限（把它当机房规格填的人会突然少线路），而是到量了告诉主人 ——
 * 和主机那两类提醒同一个思路，判断逻辑也单独拆出来测。
 *
 * 阈值直接复用界面那个仪表盘的：图标变黄的同一刻发提醒。两套阈值迟早会对不上，
 * 那时候「界面说没事、邮件说快满了」比不提醒更让人困惑。
 */
export type ProxyNodeTrafficReminder = {
  due: boolean;
  /** normal / warn / exceeded，和节点行上那个图标的颜色同源。 */
  state: ProxyNodeQuotaState;
  usedPercent: number;
  usedBytes: number;
  limitBytes: number;
  warnPercent: number;
};

export function planProxyNodeTrafficReminder(
  node: { trafficLimit?: unknown; trafficUsed?: unknown },
): ProxyNodeTrafficReminder {
  const limitBytes = Math.max(0, Math.floor(Number(node?.trafficLimit) || 0));
  const usedBytes = Math.max(0, Math.floor(Number(node?.trafficUsed) || 0));
  const quota = { trafficLimit: limitBytes, trafficUsed: usedBytes };
  const state = proxyNodeQuotaState(quota as any);
  // 没填总量就不提醒：不知道上限时「用了多少算多」无从谈起。
  const usedPercent = limitBytes > 0 ? Math.round((usedBytes / limitBytes) * 100) : 0;
  return {
    due: state === "warn" || state === "exceeded",
    state,
    usedPercent,
    usedBytes,
    limitBytes,
    warnPercent: PROXY_NODE_TRAFFIC_WARN_PERCENT,
  };
}

/**
 * 提醒的去重键要带上状态。
 *
 * 快满和已经超了是两件事：只按节点 id 去重的话，先发了「用到 80%」，当天真的跑满时
 * 就不会再发第二封 —— 而那一封才是要紧的。
 */
export function proxyNodeTrafficReminderKey(nodeId: unknown, state: ProxyNodeQuotaState): string {
  return `proxyNodeTraffic:${Math.floor(Number(nodeId) || 0)}:${state}`;
}
