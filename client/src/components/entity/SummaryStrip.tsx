import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";

import AnimatedStatValue from "@/components/AnimatedStatValue";
import { IconBadge, type IconBadgeTone } from "@/components/ui/icon-badge";
import { cn } from "@/lib/utils";

/**
 * 页面顶部的统计块：几个数并排，一个数一小格。
 *
 * 照参考站（New API / Vexo）首页的 summary cards 画：外面一张白卡，里面一排小格，每格
 * 是「图标底座 + 标签」一行、下面一个等宽字体的大数、再下面一行小灰字。格与格之间靠
 * 各自的一圈细线分开，不再是上一版那种「一个面、中间几根竖线」的摘要条 —— 那种看着
 * 像表头，这种看着像仪表。
 *
 * 图标底座只在传了 `icon` 的格上画：颜色按格的顺序从图表色板取（天蓝 / 青 / 淡靛 …），
 * 传了 `tone` 的格用状态色 —— 数字本身不正常时，底座和数字一起变色。
 */
export type SummaryItem = {
  key: string;
  label: ReactNode;
  value: string | number | null | undefined;
  /** 值下面那一行补充（「1 个管理员」「16 条已启用」）。放不下会截断。 */
  hint?: ReactNode;
  /** 悬停看的完整说明：补充那一行太长、被截断的时候用。 */
  title?: string;
  /** 需要用颜色说话时才传（状态色）。大部分数不需要颜色。 */
  tone?: "healthy" | "warn" | "down" | "path";
  /** 标签前面的图标。不传就没有底座，标签顶格。 */
  icon?: LucideIcon;
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

const SERIES_TONES: IconBadgeTone[] = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"];

function badgeTone(item: SummaryItem, index: number): IconBadgeTone {
  if (item.tone === "healthy") return "healthy";
  if (item.tone === "warn") return "warn";
  if (item.tone === "down") return "down";
  if (item.tone === "path") return "accent";
  return SERIES_TONES[index % SERIES_TONES.length];
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
  // 手机上四个折成 2×2；三个以内一行放得下。
  const grid = count >= 4 ? "grid-cols-2 sm:grid-cols-4" : count === 3 ? "grid-cols-3" : count === 2 ? "grid-cols-2" : "grid-cols-1";
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "fx-summary grid gap-2 rounded-[var(--fx-radius-surface)] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] p-2 sm:gap-3 sm:p-3",
        grid,
        className,
      )}
      data-testid="summary-strip"
    >
      {items.map((item, index) => {
        const Icon = item.icon;
        const body = (
          <>
            <span className="flex min-w-0 items-center gap-1.5 text-meta font-medium text-muted-foreground sm:gap-2">
              {Icon ? <IconBadge tone={badgeTone(item, index)}><Icon /></IconBadge> : null}
              <span className="truncate">{item.label}</span>
              {item.onClick ? <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
            </span>
            <span className="block min-w-0" style={item.tone ? { color: `var(--fx-${item.tone}-text, var(--fx-${item.tone}))` } : undefined}>
              <AnimatedStatValue
                as="span"
                value={item.value}
                loading={item.loading ?? loading}
                cacheKey={item.cacheKey}
                fallbackCacheKeys={item.fallbackCacheKeys}
                mirrorCacheKeys={item.mirrorCacheKeys}
                fallbackValue={item.fallbackValue}
                className="fx-summary-value block truncate font-mono font-semibold tabular-nums tracking-tight"
              />
            </span>
            {item.hint ? <span className="block truncate text-meta text-muted-foreground">{item.hint}</span> : null}
          </>
        );
        const cell = "fx-summary-cell flex min-w-0 flex-col gap-1 rounded-[var(--fx-radius-card)] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] px-2 py-2 text-left sm:gap-1.5 sm:p-3";
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
