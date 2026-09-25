import { Activity, ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import { SummaryStrip } from "@/components/entity/SummaryStrip";
import { formatBytes } from "@shared/formatBytes";

/**
 * 转发规则页顶上那条：累计入向、出向、连接次数，下面一行是近 24H。
 *
 * 原来是自己的一套 .workspace-metrics 样式（边框、投影、按视口缩放的字号），和别的页头摘要
 * 长得不一样；现在就是那一条摘要。切换分类（全部 / 端口转发 / 隧道转发…）时仍然先借上一个
 * 范围的数，不闪回 0 —— 缓存键和原来一模一样，升级后第一次打开照样有上次的值。
 */
type Totals = { bytesIn: number; bytesOut: number; connections: number };
export default function TrafficOverview({ total, daily, totalLoading, dailyLoading, scope, lastScope }: {
  total: Totals; daily: Totals; totalLoading: boolean; dailyLoading: boolean; scope: string; lastScope: string;
}) {
  const metrics = [
    { key: "bytesIn", label: "入向流量", icon: ArrowDownToLine, format: formatBytes },
    { key: "bytesOut", label: "出向流量", icon: ArrowUpFromLine, format: formatBytes },
    { key: "connections", label: "连接次数", icon: Activity, format: (n: number) => n.toLocaleString() },
  ] as const;
  const keys = (kind: "total" | "daily", key: string) => ({
    cacheKey: `rules.traffic.${scope}.${kind}.${key}`,
    fallbackCacheKeys: [`rules.traffic.${lastScope}.${kind}.last.${key}`, `rules.traffic.${kind}.last.${key}`],
    mirrorCacheKeys: [`rules.traffic.${lastScope}.${kind}.last.${key}`, `rules.traffic.${kind}.last.${key}`],
  });
  return (
    <SummaryStrip
      ariaLabel="累计转发流量与近 24 小时流量汇总"
      loading={totalLoading}
      items={metrics.map(({ key, label, icon, format }) => ({
        key,
        icon,
        label: <>{label}<span className="sr-only">（累计）</span></>,
        value: format(total[key]),
        fallbackValue: format(0),
        ...keys("total", key),
        hint: (
          <>
            近 24H{" "}
            <AnimatedStatValue as="span" value={format(daily[key])} loading={dailyLoading} fallbackValue={format(0)} {...keys("daily", key)} />
          </>
        ),
      }))}
    />
  );
}
