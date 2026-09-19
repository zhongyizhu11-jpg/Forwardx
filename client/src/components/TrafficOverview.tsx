import { Activity, ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import { formatBytes } from "@shared/formatBytes";

type Totals = { bytesIn: number; bytesOut: number; connections: number };
export default function TrafficOverview({ total, daily, totalLoading, dailyLoading, scope, lastScope }: {
  total: Totals; daily: Totals; totalLoading: boolean; dailyLoading: boolean; scope: string; lastScope: string;
}) {
  const metrics = [
    { key: "bytesIn", label: "入向流量", icon: ArrowDownToLine, format: formatBytes },
    { key: "bytesOut", label: "出向流量", icon: ArrowUpFromLine, format: formatBytes },
    { key: "connections", label: "连接次数", icon: Activity, format: (n: number) => n.toLocaleString() },
  ] as const;
  return <section className="workspace-metrics" aria-label="累计转发流量与近 24 小时流量汇总">
    {metrics.map(({ key, label, icon: Icon, format }) => <div key={key}>
      <p className="workspace-metric-label"><Icon className="h-4 w-4" /><span>{label}<span className="sr-only">（累计）</span></span></p>
      <AnimatedStatValue as="span" value={format(total[key])} loading={totalLoading}
        cacheKey={`rules.traffic.${scope}.total.${key}`}
        fallbackCacheKeys={[`rules.traffic.${lastScope}.total.last.${key}`, `rules.traffic.total.last.${key}`]}
        mirrorCacheKeys={[`rules.traffic.${lastScope}.total.last.${key}`, `rules.traffic.total.last.${key}`]}
        fallbackValue={format(0)} className="workspace-metric-value" />
      <div className="workspace-metric-detail"><span>近 24H</span>
        <AnimatedStatValue as="span" value={format(daily[key])} loading={dailyLoading}
          cacheKey={`rules.traffic.${scope}.daily.${key}`}
          fallbackCacheKeys={[`rules.traffic.${lastScope}.daily.last.${key}`, `rules.traffic.daily.last.${key}`]}
          mirrorCacheKeys={[`rules.traffic.${lastScope}.daily.last.${key}`, `rules.traffic.daily.last.${key}`]}
          fallbackValue={format(0)} />
      </div>
    </div>)}
  </section>;
}
