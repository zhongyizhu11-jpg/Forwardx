import { ChevronRight } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import type { ElementType } from "react";

import AnimatedStatValue from "@/components/AnimatedStatValue";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * 页面顶部那一排概览卡。
 *
 * 原来只长在仪表盘里。订阅管理要做成同一个观感时，与其把这几十行样式抄一遍，
 * 不如挪出来共用 —— 抄一遍的代价是以后调圆角、调悬停、调排版要记得改两处，
 * 而漏改的那一处会在同一个面板里显出两种气质。
 */
export type StatCardProps = {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: ElementType;
  loading?: boolean;
  /** 缓存键：刷新时先显示上次的值，避免整排数字闪一下 0。 */
  cacheKey: string;
  fallbackValue?: string | number;
  className?: string;
  /** 入场动画的次序，让一排卡片依次浮上来而不是一起弹出。 */
  index?: number;
  /**
   * 点这张卡去哪。
   *
   * 一张写着「你有 3 件事要处理」的卡片，本来就该是点进去处理的入口 —— 让人看完这个
   * 数字再自己去别处找那三件事，是把已经走完的一半路又还给他。给了 onClick 才变成
   * 可点，别的卡片照旧是纯展示。
   */
  onClick?: () => void;
};

export default function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  loading,
  cacheKey,
  fallbackValue,
  className,
  index = 0,
  onClick,
}: StatCardProps) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reducedMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={onClick && !reducedMotion ? { y: -2 } : undefined}
      transition={{ duration: 0.28, delay: index * 0.04, ease: [0.22, 1, 0.36, 1] }}
    >
      <Card
        onClick={onClick}
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
        onKeyDown={onClick
          ? (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onClick();
            }
          }
          : undefined}
        className={cn(
          "group relative h-full overflow-hidden",
          onClick && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        )}
      >
        <CardContent className="relative p-3 sm:p-5">
          <div className="flex items-start justify-between gap-2 sm:gap-4">
            <div className="min-w-0 flex-1 space-y-1.5">
              <p className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                {title}
                {/* 可点的卡片给一个安静的记号：不喊「点我」，但让人知道这后面还有东西。 */}
                {onClick ? <ChevronRight className="h-3 w-3 opacity-50 transition-transform group-hover:translate-x-0.5" /> : null}
              </p>
              <AnimatedStatValue
                as="p"
                value={value}
                loading={loading}
                cacheKey={cacheKey}
                fallbackValue={fallbackValue}
                className="break-words text-xl font-bold leading-tight tracking-tight tabular-nums sm:text-2xl"
              />
              {subtitle && (
                <AnimatedStatValue
                  as="p"
                  value={subtitle}
                  loading={loading}
                  cacheKey={`${cacheKey}.subtitle`}
                  fallbackValue=""
                  className="break-words text-xs text-muted-foreground"
                />
              )}
            </div>
            <div className="stat-card-icon hidden shrink-0 sm:flex">
              <Icon className="h-4 w-4" />
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
