import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatBytes } from "@shared/formatBytes";

/*
  仪表盘的两张图单独一个模块，让 recharts 从首屏包里出去。

  仪表盘是所有人的落地页，所以路由分包那一轮刻意把它留成同步的。代价是它
  import 的 recharts 也跟着进了主包 —— 一个只想看一眼「几台在线」的人，
  得先把整个图表库下完。而这两张图本来就有不依赖 recharts 的加载态和空态：
  数据没回来时显示骨架/转圈，那段时间正好够把图表库取回来，所以改成按需加载
  在观感上是免费的。
*/

export type TrafficPieDatum = {
  id: string | number;
  name: string;
  value: number;
  percent: number | string;
  color: string;
};

function PieTooltipContent({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const item = payload[0]?.payload;
  if (!item) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-md">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: item.color }} />
        <p className="max-w-52 truncate text-xs font-medium">{item.name}</p>
      </div>
      <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground tabular-nums">
        <span>{formatBytes(item.value)}</span>
        <span>{item.percent}%</span>
      </div>
    </div>
  );
}

function TrafficTooltipContent({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const data = payload[0]?.payload;
  if (!data) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-md">
      <p className="mb-1.5 text-xs text-muted-foreground">{data.fullLabel || label}</p>
      <div className="space-y-1">
        <p className="flex items-center gap-1.5 text-xs tabular-nums">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          <span className="text-muted-foreground">入站</span>
          <span className="ml-auto font-semibold">{formatBytes(data.bytesIn)}</span>
        </p>
        <p className="flex items-center gap-1.5 text-xs tabular-nums">
          <span className="h-2 w-2 rounded-full bg-amber-500" />
          <span className="text-muted-foreground">出站</span>
          <span className="ml-auto font-semibold">{formatBytes(data.bytesOut)}</span>
        </p>
      </div>
    </div>
  );
}

export function TrafficPieChart({
  chartData,
  total,
  shouldAnimate,
  onAnimationEnd,
}: {
  chartData: TrafficPieDatum[];
  total: number;
  shouldAnimate: boolean;
  onAnimationEnd: () => void;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
        <Pie
          data={chartData}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          startAngle={90}
          endAngle={-270}
          innerRadius="60%"
          outerRadius="80%"
          paddingAngle={2}
          minAngle={3}
          cornerRadius={6}
          label={false}
          labelLine={false}
          isAnimationActive={shouldAnimate}
          animationBegin={shouldAnimate ? 80 : 0}
          animationDuration={shouldAnimate ? 900 : 0}
          animationEasing="ease-out"
          onAnimationEnd={onAnimationEnd}
        >
          {chartData.map((item) => (
            <Cell key={item.id} fill={item.color} stroke="transparent" strokeWidth={0} />
          ))}
        </Pie>
        <text x="50%" y="46%" textAnchor="middle" dominantBaseline="central" className="fill-foreground text-sm font-semibold tabular-nums">
          {formatBytes(total)}
        </text>
        <text x="50%" y="59%" textAnchor="middle" dominantBaseline="central" className="fill-muted-foreground text-[10px]">
          合计
        </text>
        <RTooltip content={<PieTooltipContent />} wrapperStyle={{ pointerEvents: "none" }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function TrafficAreaChart({ chartData }: { chartData: any[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="trafficInGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#10b981" stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="trafficOutGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis dataKey="label" tick={{ fontSize: 9 }} minTickGap={60} interval="preserveStartEnd" />
        <YAxis
          tick={{ fontSize: 9 }}
          tickFormatter={(value) => formatBytes(value)}
          width={56}
          domain={[0, (dataMax: number) => Math.max(1024, Math.ceil((dataMax || 0) * 1.2))]}
          allowDecimals={false}
        />
        <RTooltip content={<TrafficTooltipContent />} cursor={{ stroke: "var(--color-muted-foreground)", strokeDasharray: "3 3" }} />
        <Area type="monotone" dataKey="bytesIn" name="入站" stroke="#10b981" strokeWidth={2} fill="url(#trafficInGradient)" dot={false} />
        <Area type="monotone" dataKey="bytesOut" name="出站" stroke="#f59e0b" strokeWidth={2} fill="url(#trafficOutGradient)" dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
