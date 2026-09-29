import { formatBytes } from "@shared/formatBytes";

/**
 * 抽屉里图表要的数：把服务端的几条序列整理成画图和写数字用的形状。
 *
 * 纯函数。三条序列分别来自 hosts.metricsSeries、tunnels.latencySeries、rules.trafficSummary，
 * 字段名照服务端的，这里只做取值、求统计和格式化 —— 不猜没有的数据：
 * 拿不到丢包就不写丢包，只写探测成功率，标签里说清是什么。
 */

export type HostSeriesPoint = {
  at: string | Date | number;
  cpuUsage: number | null;
  memoryUsage: number | null;
  memoryUsed: number | null;
  diskUsage: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  networkSpeedIn: number | null;
  networkSpeedOut: number | null;
  uptime: number | null;
};

export type HostVitals = {
  cpuSeries: number[];
  netInSeries: number[];
  netOutSeries: number[];
  cpuNow: number | null;
  memoryPercent: number | null;
  memoryUsed: number | null;
  diskPercent: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  /** 字节 / 秒 */
  netInNow: number | null;
  netOutNow: number | null;
  uptimeSeconds: number | null;
  sampleCount: number;
};

const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function lastFinite(points: readonly HostSeriesPoint[], pick: (point: HostSeriesPoint) => number | null): number | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = finite(pick(points[index]));
    if (value !== null) return value;
  }
  return null;
}

/** 24 小时指标序列 → 节点抽屉要的数。空洞（没有心跳的格）画成 0，别让折线断开。 */
export function summarizeHostSeries(points: readonly HostSeriesPoint[] | null | undefined): HostVitals {
  const rows = Array.isArray(points) ? points : [];
  return {
    cpuSeries: rows.map((point) => finite(point.cpuUsage) ?? 0),
    netInSeries: rows.map((point) => finite(point.networkSpeedIn) ?? 0),
    netOutSeries: rows.map((point) => finite(point.networkSpeedOut) ?? 0),
    cpuNow: lastFinite(rows, (point) => point.cpuUsage),
    memoryPercent: lastFinite(rows, (point) => point.memoryUsage),
    memoryUsed: lastFinite(rows, (point) => point.memoryUsed),
    diskPercent: lastFinite(rows, (point) => point.diskUsage),
    diskUsed: lastFinite(rows, (point) => point.diskUsed),
    diskTotal: lastFinite(rows, (point) => point.diskTotal),
    netInNow: lastFinite(rows, (point) => point.networkSpeedIn),
    netOutNow: lastFinite(rows, (point) => point.networkSpeedOut),
    uptimeSeconds: lastFinite(rows, (point) => point.uptime),
    sampleCount: rows.length,
  };
}

export type LatencySeriesRow = {
  latencyMs: number | null;
  isTimeout?: boolean | null;
  probeCount?: number | null;
  probeSuccesses?: number | null;
  recordedAt: string | Date | number;
  seriesKey?: string | null;
};

export type LatencyStats = {
  /** 按时间顺序的延迟样本；超时点是 null */
  series: Array<number | null>;
  latest: number | null;
  avg: number | null;
  max: number | null;
  /** 延迟样本标准差 */
  jitter: number | null;
  /** 探测成功率 0–100；没有探测计数时按「超时 / 未超时」算 */
  successRate: number | null;
  probeTotal: number;
  sampleCount: number;
};

function normalizeSeriesKey(value: unknown) {
  const key = String(value || "").trim().toLowerCase();
  return key || "total";
}

/**
 * 延迟序列 → 统计。多入口 / 多出口隧道每条子线路各有一个 seriesKey，
 * 地图抽屉只看整体（total；没有 total 就取 primary，再没有就全部）。
 */
export function summarizeLatencySeries(rows: readonly LatencySeriesRow[] | null | undefined): LatencyStats {
  const all = Array.isArray(rows) ? rows : [];
  const keys = new Set(all.map((row) => normalizeSeriesKey(row.seriesKey)));
  const preferred = keys.has("total") ? "total" : keys.has("primary") ? "primary" : null;
  const picked = preferred ? all.filter((row) => normalizeSeriesKey(row.seriesKey) === preferred) : all;
  const ordered = [...picked].sort((a, b) => toTime(a.recordedAt) - toTime(b.recordedAt));
  const series: Array<number | null> = [];
  const values: number[] = [];
  let probeTotal = 0;
  let probeOk = 0;
  for (const row of ordered) {
    const latency = row.isTimeout ? null : finite(row.latencyMs);
    series.push(latency);
    if (latency !== null) values.push(latency);
    const count = Math.max(0, Math.floor(finite(row.probeCount) ?? 0));
    if (count > 0) {
      probeTotal += count;
      probeOk += Math.min(count, Math.max(0, Math.floor(finite(row.probeSuccesses) ?? 0)));
    } else {
      // 老数据没有探测计数：一行就是一次探测
      probeTotal += 1;
      if (latency !== null) probeOk += 1;
    }
  }
  const avg = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const variance = avg !== null && values.length > 1
    ? values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1)
    : null;
  return {
    series,
    latest: values.length > 0 ? values[values.length - 1] : null,
    avg,
    max: values.length > 0 ? Math.max(...values) : null,
    jitter: variance !== null ? Math.sqrt(variance) : null,
    successRate: probeTotal > 0 ? (probeOk / probeTotal) * 100 : null,
    probeTotal,
    sampleCount: ordered.length,
  };
}

function toTime(value: string | Date | number) {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

export type TrafficSummaryRow = { ruleId: number; bytesIn?: number | null; bytesOut?: number | null };

/** 一组规则的流量汇总相加（抽屉里「走这条隧道的规则」加起来就是这条隧道的流量） */
export function sumTraffic(rows: readonly TrafficSummaryRow[] | null | undefined, ruleIds?: readonly number[]): { bytesIn: number; bytesOut: number } {
  const allow = ruleIds ? new Set(ruleIds) : null;
  let bytesIn = 0;
  let bytesOut = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (allow && !allow.has(Number(row.ruleId))) continue;
    bytesIn += Math.max(0, finite(row.bytesIn) ?? 0);
    bytesOut += Math.max(0, finite(row.bytesOut) ?? 0);
  }
  return { bytesIn, bytesOut };
}

/** 「37 天 4 小时」「2 小时 15 分」「刚启动」 */
export function formatUptime(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分钟`;
  return "刚启动";
}

/** 字节 / 秒 → 「12.5 Mbps」 */
export function formatBitrate(bytesPerSecond: number | null | undefined): string {
  if (typeof bytesPerSecond !== "number" || !Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return "—";
  const bits = bytesPerSecond * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gbps`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mbps`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} Kbps`;
  return `${Math.round(bits)} bps`;
}

export function formatBytesShort(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "—";
  return formatBytes(bytes);
}

export function formatLatency(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  return ms >= 100 ? `${Math.round(ms)} ms` : `${Math.round(ms * 10) / 10} ms`;
}

/** 内存 / 磁盘条的颜色档：70% 以上黄，85%（磁盘 90%）以上红 */
export function usageTone(percent: number | null, warnAt = 70, downAt = 85): "ok" | "warn" | "down" {
  if (percent === null) return "ok";
  if (percent >= downAt) return "down";
  if (percent >= warnAt) return "warn";
  return "ok";
}
