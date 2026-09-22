import { cn } from "@/lib/utils";
import { describeNetworkHealth, type NetworkHealth } from "@shared/networkHealth";

/**
 * 状态信号点。
 *
 * 这是 ForwardX 里最小的一个视觉元素，但它承担的事情最多：一屏上十几条记录，
 * 用户第一眼扫的就是这一列点。所以它只做一件事 —— 说出健康状态，不兼职表示
 * 类型、不兼职表示选中。
 *
 * 颜色全部走语义令牌（--fx-healthy / --fx-warn / --fx-down / --fx-standby），
 * 不写 emerald-500 这种。换一次主题这里不用动。
 *
 * 外圈那层光晕不是装饰：2.5px 的点在深色底上和背景噪点分不开，加一圈 12% 的
 * 同色扩散之后，点的**位置**先被看见，颜色才被读出来。
 */
export function StatusDot({
  health,
  size = "default",
  label,
  className,
}: {
  health: NetworkHealth;
  size?: "default" | "large";
  /** 给读屏的文字。不传则用状态自带的中文标签 */
  label?: string;
  className?: string;
}) {
  const descriptor = describeNetworkHealth(health);
  const token = descriptor.token;
  const dimension = size === "large" ? "h-2.5 w-2.5" : "h-2 w-2";

  return (
    <span
      role="img"
      aria-label={label || descriptor.label}
      className={cn(
        "inline-block shrink-0 rounded-full",
        dimension,
        health === "switching" && "fx-dot-pulse",
        className,
      )}
      style={{
        backgroundColor: `var(--fx-${token})`,
        boxShadow: `0 0 0 3px var(--fx-${token}-soft)`,
      }}
    />
  );
}

/**
 * 状态胶囊：点 + 文字。
 *
 * 用在标题旁边这种「需要把结论说出来」的地方。列表行里只用点就够了 ——
 * 十二行都挂一个「正常」徽标，那一列文字本身就成了噪音。
 */
export function HealthBadge({
  health,
  text,
  className,
}: {
  health: NetworkHealth;
  text?: string;
  className?: string;
}) {
  const descriptor = describeNetworkHealth(health);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[var(--fx-radius-pill)] px-2 py-0.5 text-meta font-medium",
        className,
      )}
      style={{
        color: `var(--fx-${descriptor.token}-text, var(--fx-${descriptor.token}))`,
        backgroundColor: `var(--fx-${descriptor.token}-soft)`,
      }}
    >
      <StatusDot health={health} label="" className="shadow-none" />
      {text || descriptor.label}
    </span>
  );
}
