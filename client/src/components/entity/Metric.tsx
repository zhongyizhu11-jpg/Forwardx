import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 一个数值。
 *
 * 数据型产品里数字本身就是视觉元素 —— 所以这个组件的全部职责就是让数字比
 * 它的标签和单位更显眼。
 *
 * 不要：`总延迟 8ms`   —— 一眼看到的是「总延迟」三个字
 * 要：   标签 `延迟`，值 `8`，单位 `ms`   —— 一眼看到的是 8
 *
 * 数字走 tabular-nums：一列值上下对齐之后能直接比大小，这是等宽数字在控制台
 * 里的真正价值，不只是好看。
 */
export function Metric({
  label,
  value,
  unit,
  size = "metric",
  tone,
  hint,
  className,
}: {
  label?: ReactNode;
  /** 数字本身。已经格式化好的字符串（"6.04"、"—"）或数字都行 */
  value: ReactNode;
  unit?: ReactNode;
  /** display 给首屏最大的数，metric 给区块级的数，inline 给挤在一行里的 */
  size?: "display" | "metric" | "inline";
  /** 需要用颜色说话时才传。不传就是正文色 —— 大部分数值不需要颜色 */
  tone?: "healthy" | "warn" | "down" | "path";
  /** 值下面那行补充（"近 24H"、"较基线 +41%"） */
  hint?: ReactNode;
  className?: string;
}) {
  const valueSize =
    size === "display" ? "text-display" : size === "metric" ? "text-metric" : "text-primary-type";

  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      {label ? <span className="truncate text-meta text-muted-foreground">{label}</span> : null}
      <span className="flex min-w-0 items-baseline gap-1">
        <span
          className={cn(valueSize, "truncate font-semibold tabular-nums")}
          style={tone ? { color: `var(--fx-${tone})` } : undefined}
        >
          {value}
        </span>
        {unit ? <span className="shrink-0 text-meta text-muted-foreground">{unit}</span> : null}
      </span>
      {hint ? <span className="truncate text-meta text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

/**
 * 一组数值并排。
 *
 * 用在「CPU / RAM / Disk」「入向 / 出向 / 连接数」这类场合。
 *
 * **它不画框**。上一版每一组数值都套一个卡片，于是一张主机卡里有三个嵌套的
 * 圆角矩形 —— 框本身不携带任何信息，只是在浪费边界。分组靠间距就够了。
 */
export function MetricGroup({
  columns = 3,
  className,
  children,
}: {
  columns?: 2 | 3 | 4;
  className?: string;
  children: ReactNode;
}) {
  const grid = columns === 2 ? "grid-cols-2" : columns === 4 ? "grid-cols-4" : "grid-cols-3";
  return <div className={cn("grid gap-3", grid, className)}>{children}</div>;
}

/**
 * 资源占用条（CPU / 内存 / 磁盘）。
 *
 * 标签、条、百分比同一行 —— 竖排三行去画一个百分比，在一张列表卡里放三个就是
 * 九行。条本身很细（4px），因为它要传达的是「大概多满」，精确值右边那个数字
 * 已经给了。
 *
 * 颜色按阈值走语义色：越界才变色，正常时是中性的。一条一直是绿色的进度条
 * 等于没有颜色信息。
 */
export function ResourceMeter({
  label,
  percent,
  valueText,
  warnAt = 75,
  criticalAt = 90,
  className,
}: {
  label: ReactNode;
  /** 0–100。null / undefined 表示拿不到数据，画成「—」而不是 0% */
  percent: number | null | undefined;
  /** 右边那个数的写法，不传就是四舍五入的百分比（CPU 传「<1%」这种） */
  valueText?: string;
  warnAt?: number;
  criticalAt?: number;
  className?: string;
}) {
  const known = typeof percent === "number" && Number.isFinite(percent);
  const value = known ? Math.min(100, Math.max(0, percent)) : 0;
  const color = !known
    ? "var(--fx-network-standby)"
    : value >= criticalAt
      ? "var(--fx-health-critical)"
      : value >= warnAt
        ? "var(--fx-health-warning)"
        : "var(--fx-network-path-muted)";

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <span className="w-10 shrink-0 text-meta text-muted-foreground">{label}</span>
      {/*
        轨道用线色而不是填充色。面全白之后，浅灰填充在白底上就是看不见 ——
        而一条 1px 的轨道本来就更像「一条线」，不是「一块底」。
      */}
      <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-[var(--fx-radius-pill)] bg-[var(--fx-stroke-weak)]">
        <span
          className="block h-full rounded-[var(--fx-radius-pill)]"
          style={{ width: `${value}%`, backgroundColor: color }}
        />
      </span>
      <span className="w-9 shrink-0 text-right text-meta tabular-nums text-foreground">
        {/*
          拿不到数据时写「—」而不是「0%」。一台离线的机器 CPU 不是 0%，
          是不知道 —— 写 0% 等于报了一个它没说过的数。
        */}
        {valueText ?? (known ? `${Math.round(value)}%` : "—")}
      </span>
    </div>
  );
}
