import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import AnimatedStatValue from "@/components/AnimatedStatValue";
import { cn } from "@/lib/utils";

/**
 * 页面顶部的摘要条：几个数并排在一个面上，中间一根细线分栏。
 *
 * 取代原来那一排「数字卡片」（StatCard，以及用户、支付、状态页各自抄的一份）。那种卡片
 * 一张只说一个数，却各带一个图标方块、一个最小高度和一层投影：用户管理页在 393px 上
 * 四张卡竖着排了 900 多像素，还没看到第一个用户，一屏已经没了。这几个数回答的是同一个
 * 问题的几个侧面，本来就该在一个面上 —— 主机页那条摘要就是这么画的（Surface A：一个面，
 * 内部靠线分栏，不各画各的框）。
 *
 * 分隔线靠 gap-px 露出底下的描边色画出来：两列、三列、四列、手机上折成两行，都不用
 * 单独算哪一格该有哪条边。
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
        "grid gap-px overflow-hidden rounded-[var(--fx-radius-surface)] border border-[var(--fx-stroke-weak)] bg-[var(--fx-stroke-weak)]",
        grid,
        className,
      )}
      data-testid="summary-strip"
    >
      {items.map((item) => {
        const body = (
          <>
            <span className="flex min-w-0 items-center gap-0.5 text-meta text-muted-foreground">
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
                className="block truncate text-primary-type font-semibold tabular-nums"
              />
            </span>
            {item.hint ? <span className="block truncate text-meta text-muted-foreground">{item.hint}</span> : null}
          </>
        );
        const cell = "flex min-w-0 flex-col gap-0.5 bg-[var(--fx-l1-surface)] px-3 py-2.5 text-left";
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
