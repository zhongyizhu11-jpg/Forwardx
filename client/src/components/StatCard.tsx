import { motion } from "motion/react";
import type { ElementType } from "react";

import AnimatedStatValue from "@/components/AnimatedStatValue";
import { Card, CardContent } from "@/components/ui/card";

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
  /** 右上角图标底色，用渐变类名，例如 bg-gradient-to-br from-teal-500 to-teal-600。 */
  tone: string;
  loading?: boolean;
  /** 缓存键：刷新时先显示上次的值，避免整排数字闪一下 0。 */
  cacheKey: string;
  fallbackValue?: string | number;
  className?: string;
  /** 入场动画的次序，让一排卡片依次浮上来而不是一起弹出。 */
  index?: number;
};

export default function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  tone,
  loading,
  cacheKey,
  fallbackValue,
  className,
  index = 0,
}: StatCardProps) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.28, delay: index * 0.04, ease: [0.22, 1, 0.36, 1] }}
    >
      <Card className="group relative h-full overflow-hidden border-border/40 bg-card/60 backdrop-blur-md transition-all duration-300 hover:border-border/70 hover:shadow-lg hover:shadow-primary/5">
        <div className={`absolute inset-0 opacity-[0.04] transition-opacity group-hover:opacity-[0.08] ${tone}`} />
        <CardContent className="relative p-3 sm:p-5">
          <div className="flex items-start justify-between gap-2 sm:gap-4">
            <div className="min-w-0 flex-1 space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
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
                  className="break-words text-xs text-muted-foreground/80"
                />
              )}
            </div>
            <div className={`hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone} shadow-sm sm:flex`}>
              <Icon className="h-5 w-5 text-white" />
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
