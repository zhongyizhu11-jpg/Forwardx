import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";

import AnimatedStatValue from "@/components/AnimatedStatValue";
import { IconTile, type IconTileTone } from "@/components/entity/IconTile";
import { cn } from "@/lib/utils";

/**
 * 页面顶部的统计行：几个数并排，一格一个数。
 *
 * 上一版是「外面一张白卡，里面一排小格，每格再描一圈线」—— 同一条边界画了两次，
 * 而且大数用等宽字体、首页的大数用正文字体，两页对不上。这一版按 2026-09-26 那份
 * 版式提案（「线路」方向）的统计行画：**不画框**，上下各一条细线，格与格之间一条竖线，
 * 标签在上、大数在中、一行状态色的小字在下。它是一行读数，不是三张小卡。
 *
 * 数字统一用正文字体的等宽数字（tabular-nums），和首页、表格里的数一个样。
 */
export type SummaryItem = {
  key: string;
  label: ReactNode;
  value: string | number | null | undefined;
  /** 值下面那一行补充（「1 个管理员」「16 条已启用」）。放不下会截断。 */
  hint?: ReactNode;
  /** 悬停看的完整说明：补充那一行太长、被截断的时候用。 */
  title?: string;
  /** 需要用颜色说话时才传（状态色）：数字本身跟着变色。大部分数不需要颜色。 */
  tone?: "healthy" | "warn" | "down" | "path";
  /** 只给补充那一行上色（「3 在线」绿、「1 异常」琥珀），数字保持黑色。 */
  hintTone?: "healthy" | "warn" | "down";
  /** 标签前面的图标：一枚 20px 的小图标格（IconTile），底色由 iconTone 定，默认主色。 */
  icon?: LucideIcon;
  iconTone?: IconTileTone;
  /**
   * 这个数本身就是一件要去处理的事（「待处理 33」）时，点它直接过去 —— 让人看完这个数
   * 再自己去别处找，是把走完的一半路又还给他。
   */
  onClick?: () => void;
  /** 这一个数自己还在加载（不传就跟着整条的 loading）。 */
  loading?: boolean;
  /** 刷新时先显示上次的值，不闪回 0（AnimatedStatValue 的缓存键）。 */
  cacheKey?: string;
  /** 这个键还没有值时，依次借这几个键的值（切换筛选时借上一个范围的数，不闪回 0）。 */
  fallbackCacheKeys?: string[];
  /** 同时写进这几个键，给下一次借用。 */
  mirrorCacheKeys?: string[];
  fallbackValue?: string | number;
};

function toneColor(tone: "healthy" | "warn" | "down" | "path" | undefined) {
  if (!tone) return undefined;
  if (tone === "path") return "var(--fx-accent)";
  return `var(--fx-${tone}-text, var(--fx-${tone}))`;
}

export function SummaryStrip({
  items,
  loading = false,
  ariaLabel,
  className,
}: {
  /** 2–4 个。再多就不是「一眼看完」了，该拆成列表。 */
  items: SummaryItem[];
  loading?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const count = items.length;
  // 四个也排一行：一格只有标签、数、一行小字，90px 宽放得下；折成 2×2 就成了四张卡。
  const grid = count >= 4 ? "grid-cols-4" : count === 3 ? "grid-cols-3" : count === 2 ? "grid-cols-2" : "grid-cols-1";
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn("fx-summary grid border-y border-[var(--fx-stroke-weak)]", grid, className)}
      data-testid="summary-strip"
    >
      {items.map((item) => {
        const Icon = item.icon;
        const hintColor = toneColor(item.hintTone ?? (item.tone === "path" ? undefined : item.tone));
        const body = (
          <>
            <span className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
              {Icon ? <IconTile icon={Icon} tone={item.iconTone} size="xs" /> : null}
              <span className="truncate">{item.label}</span>
              {item.onClick ? <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
            </span>
            <span className="block min-w-0" style={item.tone ? { color: toneColor(item.tone) } : undefined}>
              <AnimatedStatValue
                as="span"
                value={item.value}
                loading={item.loading ?? loading}
                cacheKey={item.cacheKey}
                fallbackCacheKeys={item.fallbackCacheKeys}
                mirrorCacheKeys={item.mirrorCacheKeys}
                fallbackValue={item.fallbackValue}
                className="fx-summary-value block truncate font-semibold tabular-nums tracking-tight"
              />
            </span>
            {item.hint ? (
              <span
                className={cn("block truncate text-meta", hintColor ? "font-medium" : "text-muted-foreground")}
                style={hintColor ? { color: hintColor } : undefined}
              >
                {item.hint}
              </span>
            ) : null}
          </>
        );
        const cell = "fx-summary-cell flex min-w-0 flex-col gap-0.5 border-l border-[var(--fx-stroke-weak)] py-2.5 pl-3 pr-1 text-left first:border-l-0 first:pl-0.5 sm:py-3 sm:pl-4";
        return item.onClick ? (
          <button
            key={item.key}
            type="button"
            onClick={item.onClick}
            title={item.title}
            className={cn(cell, "transition-colors hover:bg-[var(--fx-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}
          >
            {body}
          </button>
        ) : (
          <div key={item.key} className={cell} title={item.title}>
            {body}
          </div>
        );
      })}
    </div>
  );
}
