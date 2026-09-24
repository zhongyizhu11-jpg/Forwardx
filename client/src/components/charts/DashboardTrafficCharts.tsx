import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { CHART_TRAFFIC_COLORS } from "@/lib/chartPalette";
import { formatBytes } from "@shared/formatBytes";

/*
  仪表盘的走势图单独一个模块，让 recharts 从首屏包里出去。

  仪表盘是所有人的落地页，所以路由分包那一轮刻意把它留成同步的。代价是它
  import 的 recharts 也跟着进了主包 —— 一个只想看一眼「几台在线」的人，
  得先把整个图表库下完。而这张图本来就有不依赖 recharts 的加载态和空态：
  数据没回来时显示骨架，那段时间正好够把图表库取回来，所以改成按需加载
  在观感上是免费的。

  （原来这里还有一张环形图，给首页的三张「按类型分的流量」卡用。那三张卡换成了
  一张排行 —— 见 features/dashboard/trafficRanking —— 环形图就没有人用了。）
*/

function TrafficTooltipContent({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const data = payload[0]?.payload;
  if (!data) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-md">
      <p className="mb-1.5 text-xs text-muted-foreground">{data.fullLabel || label}</p>
      <div className="space-y-1">
        <p className="flex items-center gap-1.5 text-xs tabular-nums">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: CHART_TRAFFIC_COLORS.in }} />
          <span className="text-muted-foreground">入站</span>
          <span className="ml-auto font-semibold">{formatBytes(data.bytesIn)}</span>
        </p>
        <p className="flex items-center gap-1.5 text-xs tabular-nums">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: CHART_TRAFFIC_COLORS.out }} />
          <span className="text-muted-foreground">出站</span>
          <span className="ml-auto font-semibold">{formatBytes(data.bytesOut)}</span>
        </p>
      </div>
    </div>
  );
}

const AXIS_TICK = { fontSize: 10, fill: "var(--fx-text-muted)" };

/**
 * Y 轴刻度：一个 <text>，不折行。
 *
 * 默认刻度会按轴宽自动折词，「12.66 GB」被拆成数字一行、单位一行 —— 一根轴上
 * 五个刻度就是十行字。加宽轴只能把折行推迟到更大的数，还白占手机上的横向空间；
 * 刻度本来就一行放得下，问题只是它会折。
 */
function ByteAxisTick({ x, y, payload }: { x?: number; y?: number; payload?: { value?: number } }) {
  return (
    <text x={x} y={y} dy={3} textAnchor="end" fontSize={AXIS_TICK.fontSize} fill={AXIS_TICK.fill}>
      {formatBytes(payload?.value ?? 0)}
    </text>
  );
}

export function TrafficAreaChart({ chartData }: { chartData: any[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={chartData} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
        <defs>
          {/*
            只有入站那条带一层浅浅的面：两条都铺满的话，重叠的地方糊成一块，
            哪条在上面都分不清。出站只画线。
          */}
          <linearGradient id="trafficInGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" style={{ stopColor: CHART_TRAFFIC_COLORS.in, stopOpacity: 0.24 }} />
            <stop offset="95%" style={{ stopColor: CHART_TRAFFIC_COLORS.in, stopOpacity: 0.02 }} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--fx-stroke-weak)" />
        <XAxis
          dataKey="label"
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: "var(--fx-stroke-weak)" }}
          minTickGap={60}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={<ByteAxisTick />}
          tickLine={false}
          axisLine={false}
          width={60}
          domain={[0, (dataMax: number) => Math.max(1024, Math.ceil((dataMax || 0) * 1.2))]}
          allowDecimals={false}
        />
        <RTooltip content={<TrafficTooltipContent />} cursor={{ stroke: "var(--fx-stroke-strong)", strokeDasharray: "3 3" }} />
        <Area type="monotone" dataKey="bytesIn" name="入站" stroke={CHART_TRAFFIC_COLORS.in} strokeWidth={2} fill="url(#trafficInGradient)" dot={false} />
        <Area type="monotone" dataKey="bytesOut" name="出站" stroke={CHART_TRAFFIC_COLORS.out} strokeWidth={1.5} fill="none" dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
