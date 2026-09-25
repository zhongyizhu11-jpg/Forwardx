import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 图标底座：一个带淡色底的小圆角方块，里面一枚图标。
 *
 * 照参考站（New API / Vexo）统计块上的 IconBadge：标签前面那一小块颜色是整张白纸上
 * 少数几处彩色，靠它一眼分出「这是哪一组数」。底色是对应色兑 14%，图标用实色。
 *
 * 色调只有两类：图表色板的前五位（分类，没有语义）和状态色（有语义）。要说「这组数
 * 不正常」用状态色；只是「第几组」用图表色。
 */
export type IconBadgeTone =
  | "chart-1" | "chart-2" | "chart-3" | "chart-4" | "chart-5"
  | "healthy" | "warn" | "down" | "standby" | "accent";

const TONE_VAR: Record<IconBadgeTone, string> = {
  "chart-1": "--fx-chart-1",
  "chart-2": "--fx-chart-2",
  "chart-3": "--fx-chart-3",
  "chart-4": "--fx-chart-4",
  "chart-5": "--fx-chart-5",
  healthy: "--fx-healthy",
  warn: "--fx-warn",
  down: "--fx-down",
  standby: "--fx-standby",
  accent: "--fx-accent-strong",
};

export function IconBadge({
  tone = "chart-1",
  size = "stat",
  className,
  children,
}: {
  tone?: IconBadgeTone;
  /** stat 是统计块标签前那一颗（28px），sm 是列表行里的（24px） */
  size?: "stat" | "sm";
  className?: string;
  children: ReactNode;
}) {
  const color = `var(${TONE_VAR[tone]})`;
  return (
    <span
      data-slot="icon-badge"
      data-tone={tone}
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[8px]",
        size === "stat" ? "h-7 w-7 [&>svg]:h-3.5 [&>svg]:w-3.5" : "h-6 w-6 rounded-[7px] [&>svg]:h-3 [&>svg]:w-3",
        className,
      )}
      style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      {children}
    </span>
  );
}
