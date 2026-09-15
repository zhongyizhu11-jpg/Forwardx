/**
 * 状态小圆点，流量计费配置和套餐管理原来各存一份。
 *
 * 绿/黄/灰是三个语义档位（在线、需要注意、离线或未配置），外圈那层光晕让它
 * 在深色底上也看得见。同一个点在两页该是同一个意思。
 */
export function StatusDot({ tone }: { tone: "online" | "warning" | "offline" }) {
  const className = tone === "online"
    ? "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.16)]"
    : tone === "warning"
    ? "bg-amber-400 shadow-[0_0_0_3px_rgba(251,191,36,0.18)]"
    : "bg-muted-foreground/35";
  return <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${className}`} aria-hidden="true" />;
}

export function renderStatusDot(tone: "online" | "warning" | "offline") {
  return <StatusDot tone={tone} />;
}

export type ResourceStatusTone = "online" | "warning" | "offline";

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
