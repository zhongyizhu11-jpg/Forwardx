import type { NetworkHealth } from "@shared/networkHealth";

/**
 * 链路可用性 → 状态词汇表。
 *
 * 链路页原来自己画状态点，颜色写死在一个四分支的 if 里：
 *
 *   available   → bg-chart-2 + animate-pulse
 *   degraded    → bg-amber-400
 *   unavailable → bg-destructive/70
 *   其余         → bg-muted-foreground/30
 *
 * 三个问题：
 *
 * 一、颜色是调色板名不是语义名，换主题要一处处找，而且和主机页的绿不是
 *     同一个绿 —— 同一套系统里「正常」有两种绿，用户会以为它们不是一回事。
 *
 * 二、`available` 带 animate-pulse。脉冲在 V2 里是**切换中**这个瞬时态专用的；
 *     给「一切正常」加脉冲，等于让一屏上所有正常的链路都在闪，真正在切换的
 *     那一条反而淹没了。动效要留给需要被注意到的东西。
 *
 * 三、`pending` 和 `degraded` 被并成同一个黄。但它们不是一回事：pending 是
 *     「还没测出来」（unknown），degraded 是「测出来了，不太好」。把没有结论
 *     的显示成有结论的，正是这套词汇表要避免的。
 */
export function tunnelHealthFromAvailability(
  status: string | null | undefined,
  options: { enabled?: boolean; supported?: boolean } = {},
): NetworkHealth {
  // 协议没启用时这条链路根本跑不起来 —— 那是故障，不是「待命」。
  if (options.supported === false) return "down";
  // 手动停用是按设计没在跑，和探测失败要分开。
  if (options.enabled === false) return "standby";

  switch (String(status || "").toLowerCase()) {
    case "available":
      return "healthy";
    case "degraded":
      return "degraded";
    case "unavailable":
      return "down";
    case "disabled":
      return "standby";
    case "pending":
      // 「还在测」不是「有问题」，也不是「正常」。
      return "unknown";
    default:
      return "unknown";
  }
}
