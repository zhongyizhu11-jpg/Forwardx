import { StatusDot as NetworkStatusDot } from "@/components/network/StatusDot";
import type { NetworkHealth } from "@shared/networkHealth";

/**
 * V1 的三档状态点。**新代码不要用**，直接用 components/network/StatusDot。
 *
 * 这里只剩一层转接：画法归 V2 那一份（语义令牌、读屏文字、切换中的脉冲都在
 * 那边），这边负责把 V1 的三个词翻过去，让还没迁移的页面继续跑。
 *
 * 翻译表故意和 shared/networkHealth.ts 的 fromLegacyTone 不一样：
 *
 *   那边 offline → down（红），因为语义上「掉线」才是该被看见的那个意思；
 *   这边 offline → standby（灰），因为 V1 这个点**画出来就是灰的**。
 *
 * V1 的 offline 混了「掉线」和「停用」两件事。一个被手动停用的转发组翻成红色
 * 是在报一个不存在的故障，所以转接层保持现状的灰；页面迁到 V2 时应该自己判断
 * 到底是 down 还是 standby，而不是继续用这三个词。
 */
export type ResourceStatusTone = "online" | "warning" | "offline";

const LEGACY_RENDER_HEALTH: Record<ResourceStatusTone, NetworkHealth> = {
  online: "healthy",
  warning: "degraded",
  offline: "standby",
};

export function StatusDot({ tone }: { tone: ResourceStatusTone }) {
  return <NetworkStatusDot health={LEGACY_RENDER_HEALTH[tone] || "unknown"} size="large" />;
}

export function renderStatusDot(tone: ResourceStatusTone) {
  return <StatusDot tone={tone} />;
}

/**
 * 一个资源（主机 / 隧道 / 转发组之类）该亮什么颜色的点。
 *
 * 流量计费配置和套餐管理原来各存一份，判断完全一样、只是分支顺序不同
 * （一个先判隧道、一个先判主机，而分支互斥所以结果相同）。两页摆的是**同一批
 * 资源**，颜色不一致会让人以为是两种东西 —— 所以判定和画法放在一起，只此一份。
 *
 * 三档的含义：能用（绿）、配着但没跑起来或探测超时（黄）、没了或停用（灰）。
 * 「资源不存在」排在最前面：一个被删掉的资源既不是在线也不是离线，
 * 说成离线会让人以为它还在、只是掉线了。
 */
export function resourceStatusTone(
  kind: "host" | "tunnel" | string,
  item: any,
): ResourceStatusTone {
  if (!item || item.missing) return "offline";
  if (kind === "host") return item.isOnline ? "online" : "offline";
  if (kind === "tunnel") {
    if (item.isRunning) return "online";
    if (item.isEnabled) return "warning";
    return "offline";
  }
  if (item.isEnabled === false) return "offline";
  if (String(item.lastStatus || "").toLowerCase() === "error") return "offline";
  if (item.latestLatencyIsTimeout) return "warning";
  return "online";
}
