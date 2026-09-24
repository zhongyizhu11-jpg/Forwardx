/**
 * 图表色板 —— 唯一来源。
 *
 * 之前 Home.tsx 里是一串写死的十六进制（#2563eb / #10b981 / #f59e0b / ...），
 * 分散在饼图、环形进度、面积图三处。写死的后果有两个：换主题要一处处找，
 * 以及**同一份数据在两个地方是两种颜色** —— 列表里「在线」是语义绿
 * #1a8c4a，饼图里的「在线」却是 emerald-500 #10b981，用户看到的是两个绿。
 *
 * 所以前四位刻意绑定状态色：图表里的绿就是列表里的绿。后面几位才是纯分类色，
 * 只在「第 5 个以后的分片」这种没有语义的场合用。
 *
 * 值返回 `var(--fx-chart-N)` 而不是解析后的十六进制：SVG 的 fill/stroke 和
 * 内联 style 都认 CSS 变量，于是切深色模式时图表跟着变，不用重新渲染。
 */

/** 无语义的分类色板，按顺序取，用 % 回绕。 */
export const CHART_SERIES_COLORS = [
  "var(--fx-chart-1)",
  "var(--fx-chart-2)",
  "var(--fx-chart-3)",
  "var(--fx-chart-4)",
  "var(--fx-chart-5)",
  "var(--fx-chart-6)",
  "var(--fx-chart-7)",
  "var(--fx-chart-8)",
  "var(--fx-chart-9)",
  "var(--fx-chart-10)",
] as const;

export function chartSeriesColor(index: number): string {
  const size = CHART_SERIES_COLORS.length;
  const safe = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0;
  return CHART_SERIES_COLORS[safe % size];
}

/**
 * 有语义的那几个，按状态取。
 *
 * 图表要表达「健康 / 警告 / 故障 / 待命」时用这组，不要去 CHART_SERIES_COLORS
 * 里挑一个看着像的 —— 挑出来的那个和列表里的状态点不是同一个颜色。
 */
export const CHART_SEMANTIC_COLORS = {
  healthy: "var(--fx-health-good)",
  warning: "var(--fx-health-warning)",
  critical: "var(--fx-health-critical)",
  standby: "var(--fx-network-standby)",
  /** 网络路径 / 主数据系列。ForwardX 的识别色 */
  path: "var(--fx-network-path)",
  delivery: "var(--fx-delivery)",
} as const;

/**
 * 流量走势的两条线：入站 / 出站。
 *
 * 入站走路径青 ——「流动的数据」本来就是路径色的语义；出站走中性。
 *
 * 上一版是入站「正常」绿、出站「降级」琥珀，而且写死成 #10b981 / #f59e0b：出站
 * 流量不是一个警告，一张流量图上一半的线是琥珀色，看着像有一半出了问题。进出
 * 不是状态，只有一条线需要颜色来和另一条分开。
 */
export const CHART_TRAFFIC_COLORS = {
  in: CHART_SEMANTIC_COLORS.path,
  out: "var(--fx-text-muted)",
} as const;
