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
