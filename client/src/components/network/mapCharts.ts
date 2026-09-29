/**
 * 网络地图抽屉里的小图表：CPU sparkline、入站 / 出站双线、延迟走势（对数轴 + 阈值线）。
 *
 * 用 canvas 而不是 recharts：抽屉里一次要画三四张、拖动抽屉时还要跟着重画，
 * SVG 图表每次都重建几百个节点，手机上拖起来会掉帧；canvas 一帧几毫秒。
 * 颜色由调用方从 CSS 变量里读出来传进来（canvas 不认 var()）。
 *
 * 画布尺寸按 devicePixelRatio 放大，否则 Retina 上线是糊的。
 */

export type ChartPalette = {
  line: string;
  muted: string;
  grid: string;
  warn: string;
  font: string;
};

export type LineChartOptions = {
  color: string;
  /** 固定上限（CPU 是 100），不传按数据 * 1.15 */
  max?: number;
  /** 对数轴：延迟从几毫秒到几百毫秒都要看得见 */
  log?: boolean;
  /** 阈值线（对数轴时画） */
  threshold?: number;
  /** 左右两端的时间标注 */
  axisLabels?: [string, string];
  palette: ChartPalette;
};

/** 数据的纵轴上限：留 15% 的头，全 0 时给 1 免得除零 */
export function chartCeiling(values: ReadonlyArray<number | null>, fixedMax?: number): number {
  if (typeof fixedMax === "number" && fixedMax > 0) return fixedMax;
  let max = 0;
  for (const value of values) if (typeof value === "number" && Number.isFinite(value) && value > max) max = value;
  return max > 0 ? max * 1.15 : 1;
}

/** 对数轴上要画的刻度：10 / 100 / 1000 里不超过上限的那些 */
export function logTicks(ceiling: number): number[] {
  return [10, 100, 1000].filter((tick) => tick <= Math.max(10, ceiling));
}

/** 把值映射到 0–1（0 是底），对数轴按 log10 */
export function normalizeValue(value: number, ceiling: number, log: boolean): number {
  if (log) {
    const lv = Math.log10(Math.max(1, value));
    const lh = Math.log10(Math.max(10, ceiling));
    return Math.max(0, Math.min(1, lv / lh));
  }
  return Math.max(0, Math.min(1, value / (ceiling || 1)));
}

/** #rrggbb → rgba(r,g,b,a)；别的格式原样返回（调用方已经用 canvas 归一过颜色） */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (rgb) {
    const parts = rgb[1].split(/[\s,\/]+/).filter(Boolean).slice(0, 3);
    if (parts.length === 3) return `rgba(${parts.join(",")},${alpha})`;
  }
  return color;
}

type Prepared = { ctx: CanvasRenderingContext2D; width: number; height: number };

function prepare(canvas: HTMLCanvasElement): Prepared | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return null;
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

/** 单条折线 + 渐变面积；超时点（null）断开 */
export function drawLineChart(canvas: HTMLCanvasElement, data: ReadonlyArray<number | null>, options: LineChartOptions) {
  const prepared = prepare(canvas);
  if (!prepared) return;
  const { ctx, width, height } = prepared;
  const { palette } = options;
  const hasAxis = !!options.log || !!options.axisLabels;
  const pad = { left: options.log ? 30 : 4, right: 6, top: 8, bottom: hasAxis ? 14 : 4 };
  const ceiling = chartCeiling(data, options.max);
  const n = Math.max(1, data.length - 1);
  const X = (index: number) => pad.left + (index / n) * (width - pad.left - pad.right);
  const Y = (value: number) => pad.top + (1 - normalizeValue(value, ceiling, !!options.log)) * (height - pad.top - pad.bottom);
  ctx.font = `10px ${palette.font}`;
  ctx.fillStyle = palette.muted;
  ctx.strokeStyle = palette.grid;
  ctx.lineWidth = 1;
  const ticks = options.log ? logTicks(ceiling) : [ceiling / 2];
  for (const tick of ticks) {
    const y = Y(tick);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    if (options.log) ctx.fillText(String(tick), 0, y + 3);
  }
  if (options.threshold && options.log) {
    const ty = Y(options.threshold);
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = palette.warn;
    ctx.beginPath(); ctx.moveTo(pad.left, ty); ctx.lineTo(width - pad.right, ty); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = palette.warn;
    // 全程都在阈值以下时阈值线贴着图顶，字写在线上面会被裁掉，改写到线下面
    ctx.fillText(`${options.threshold} ms 阈值`, pad.left + 4, ty - 3 < pad.top + 10 ? ty + 11 : ty - 3);
    ctx.fillStyle = palette.muted;
  }
  if (options.axisLabels) {
    ctx.textAlign = "left"; ctx.fillText(options.axisLabels[0], pad.left, height - 2);
    ctx.textAlign = "right"; ctx.fillText(options.axisLabels[1], width - pad.right, height - 2);
    ctx.textAlign = "left";
  }
  if (data.length === 0) return;
  // 面积：每段连续的数据一块
  const segments: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];
  data.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    current.push([X(index), Y(value)]);
  });
  if (current.length) segments.push(current);
  const gradient = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom);
  gradient.addColorStop(0, withAlpha(options.color, 0.28));
  gradient.addColorStop(1, withAlpha(options.color, 0.02));
  for (const segment of segments) {
    if (segment.length < 2) continue;
    ctx.beginPath();
    segment.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.lineTo(segment[segment.length - 1][0], height - pad.bottom);
    ctx.lineTo(segment[0][0], height - pad.bottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
  }
  ctx.strokeStyle = options.color;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = "round";
  for (const segment of segments) {
    ctx.beginPath();
    segment.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
    if (segment.length === 1) { ctx.beginPath(); ctx.arc(segment[0][0], segment[0][1], 1.5, 0, Math.PI * 2); ctx.fillStyle = options.color; ctx.fill(); }
  }
  if (options.threshold && options.log) {
    ctx.fillStyle = palette.warn;
    data.forEach((value, index) => {
      if (value !== null && value > options.threshold!) { ctx.beginPath(); ctx.arc(X(index), Y(value), 2.2, 0, Math.PI * 2); ctx.fill(); }
    });
  }
  // 超时点：在底边画一个小红刻度，看得出「这里没测通」
  ctx.fillStyle = palette.warn;
  data.forEach((value, index) => {
    if (value === null) ctx.fillRect(X(index) - 0.5, height - pad.bottom - 4, 1, 4);
  });
  const last = segments.length ? segments[segments.length - 1][segments[segments.length - 1].length - 1] : null;
  if (last) {
    ctx.beginPath(); ctx.arc(last[0], last[1], 3, 0, Math.PI * 2); ctx.fillStyle = options.color; ctx.fill();
    ctx.beginPath(); ctx.arc(last[0], last[1], 6, 0, Math.PI * 2); ctx.fillStyle = withAlpha(options.color, 0.25); ctx.fill();
  }
}

export type DualChartOptions = {
  colorA: string;
  colorB: string;
  palette: ChartPalette;
  /** 纵轴刻度怎么写（比如字节 / 秒 → Mbps） */
  formatTick: (value: number) => string;
  axisLabels?: [string, string];
};

/** 入站 / 出站两条线叠在一起 */
export function drawDualChart(canvas: HTMLCanvasElement, a: readonly number[], b: readonly number[], options: DualChartOptions) {
  const prepared = prepare(canvas);
  if (!prepared) return;
  const { ctx, width, height } = prepared;
  const { palette } = options;
  const pad = { left: 44, right: 6, top: 8, bottom: 14 };
  const ceiling = chartCeiling([...a, ...b]);
  const n = Math.max(1, Math.max(a.length, b.length) - 1);
  const X = (index: number) => pad.left + (index / n) * (width - pad.left - pad.right);
  const Y = (value: number) => pad.top + (1 - normalizeValue(value, ceiling, false)) * (height - pad.top - pad.bottom);
  ctx.font = `10px ${palette.font}`;
  ctx.fillStyle = palette.muted;
  ctx.strokeStyle = palette.grid;
  ctx.lineWidth = 1;
  for (const fraction of [0.5, 1]) {
    const y = Y(ceiling * fraction);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    ctx.fillText(options.formatTick(ceiling * fraction), 0, y + 3);
  }
  if (options.axisLabels) {
    ctx.textAlign = "left"; ctx.fillText(options.axisLabels[0], pad.left, height - 2);
    ctx.textAlign = "right"; ctx.fillText(options.axisLabels[1], width - pad.right, height - 2);
    ctx.textAlign = "left";
  }
  for (const [data, color] of [[a, options.colorA], [b, options.colorB]] as Array<[readonly number[], string]>) {
    if (data.length === 0) continue;
    ctx.beginPath();
    data.forEach((value, index) => (index === 0 ? ctx.moveTo(X(index), Y(value)) : ctx.lineTo(X(index), Y(value))));
    ctx.lineTo(X(data.length - 1), height - pad.bottom);
    ctx.lineTo(X(0), height - pad.bottom);
    ctx.closePath();
    ctx.fillStyle = withAlpha(color, 0.12);
    ctx.fill();
    ctx.beginPath();
    data.forEach((value, index) => (index === 0 ? ctx.moveTo(X(index), Y(value)) : ctx.lineTo(X(index), Y(value))));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

/**
 * 把任何 CSS 颜色（含 var() 解析后的 oklch / rgb 空格写法）归一成 canvas 和 MapLibre 都认的
 * `#rrggbb` 或 `rgba()`：让浏览器自己解析一遍再读回来。解析不了返回 fallback。
 */
export function resolveCssColor(value: string, fallback: string): string {
  const text = String(value || "").trim();
  if (!text) return fallback;
  if (typeof document === "undefined") return text;
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return text;
    ctx.fillStyle = "#010203";
    ctx.fillStyle = text;
    const parsed = String(ctx.fillStyle);
    return parsed === "#010203" && text.replace(/\s/g, "").toLowerCase() !== "#010203" ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** 读容器上的 CSS 变量并归一成颜色 */
export function readCssColor(element: Element | null, name: string, fallback: string): string {
  if (!element || typeof getComputedStyle === "undefined") return fallback;
  const raw = getComputedStyle(element).getPropertyValue(name);
  return resolveCssColor(raw, fallback);
}
