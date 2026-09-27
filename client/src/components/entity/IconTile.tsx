import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * 一枚 iOS「设置」那种的小图标格：圆角方块、一道柔和的渐变底、白色的线条图标。
 *
 * 用户说卡片和小图标要「美观有个性，不要为了精简而精减」。灰色的裸图标读起来是标签，
 * 这种带底色的小格读起来是一个「东西」—— 主机、线路、转发各有各的颜色，一眼分得开，
 * 也让一张全是字的卡有了一个视觉锚点。
 *
 * 色相是身份不是状态：sky 是面板的主色（跟着「默认配色」换），violet / teal / orange /
 * pink / green 是固定的几档。状态仍旧只由状态点、状态字说；这些格子不会因为出事变红。
 */
export type IconTileTone = "sky" | "violet" | "teal" | "orange" | "pink" | "green";

export function IconTile({
  icon: Icon,
  tone = "sky",
  size = "md",
  className,
  label,
}: {
  icon: LucideIcon;
  tone?: IconTileTone;
  /** xs 20px（统计行、分组标题）、sm 28px（列表行）、md 36px（卡头）、lg 40px */
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
  /** 给读屏的名字；不传就是装饰 */
  label?: string;
}) {
  return (
    <span
      className={cn("fx-tile", className)}
      data-tone={tone}
      data-size={size}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <Icon strokeWidth={2.1} aria-hidden="true" />
    </span>
  );
}
