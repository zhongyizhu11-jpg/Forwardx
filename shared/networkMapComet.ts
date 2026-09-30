import type { LngLat } from "./networkMapGeometry";

/**
 * 飞线上跑的「彗星」：一颗亮头 + 一截渐隐的尾巴，沿隧道的大圆弧从入口飞向出口，到头
 * 停一小会儿再从头来 —— 方向一眼就看得出，比来回闪的虚线直白。
 *
 * 纯数学、不碰 MapLibre：路径按 Web 墨卡托的长度参数化（屏幕上匀速，不会在高纬度
 * 突然变快），多跳隧道把每一跳的弧首尾相接成一条路，彗星一跳一跳往下跑。画布每帧
 * 只做「相位 → 采样」这一步，然后把头和尾写进 GeoJSON 源。
 */

export type MercatorPoint = { x: number; y: number };

/** Web 墨卡托，整个世界宽 1：屏幕像素 = 单位 × 512 × 2^zoom */
export function mercator(point: LngLat): MercatorPoint {
  const lat = Math.max(-85.051129, Math.min(85.051129, point[1]));
  return {
    x: point[0] / 360 + 0.5,
    y: 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI),
  };
}

export type CometPath = {
  /** 首尾相接后的折线（经纬度） */
  points: LngLat[];
  /** 每个顶点处的累计长度（墨卡托单位） */
  cum: number[];
  total: number;
  /** 每一跳结束处的累计长度（和 hops 一一对应） */
  hopEnds: number[];
};

/**
 * 把一条隧道的各跳弧线接成一条路。相邻两跳共用一台主机，后一跳的第一个点和前一跳的
 * 最后一个点重合，接的时候去掉重复的那个；长度为零的路（所有点重合）返回 null。
 */
export function buildCometPath(hops: ReadonlyArray<ReadonlyArray<LngLat>>): CometPath | null {
  const points: LngLat[] = [];
  const cum: number[] = [];
  const hopEnds: number[] = [];
  let total = 0;
  let previous: MercatorPoint | null = null;
  for (const hop of hops) {
    for (let index = 0; index < hop.length; index += 1) {
      const point = hop[index];
      const last = points[points.length - 1];
      if (last && last[0] === point[0] && last[1] === point[1]) continue;
      const projected = mercator(point);
      if (previous) total += Math.hypot(projected.x - previous.x, projected.y - previous.y);
      points.push([point[0], point[1]]);
      cum.push(total);
      previous = projected;
    }
    hopEnds.push(total);
  }
  if (points.length < 2 || !(total > 0)) return null;
  return { points, cum, total, hopEnds };
}

/** 路上离起点 s 远的那个点（s 夹在 [0, total] 里） */
export function pointAt(path: CometPath, s: number): LngLat {
  const { points, cum } = path;
  if (s <= 0) return points[0];
  if (s >= path.total) return points[points.length - 1];
  let low = 0;
  let high = cum.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (cum[mid] <= s) low = mid;
    else high = mid;
  }
  const span = cum[high] - cum[low];
  const f = span > 0 ? (s - cum[low]) / span : 0;
  return [points[low][0] + (points[high][0] - points[low][0]) * f, points[low][1] + (points[high][1] - points[low][1]) * f];
}

/** 离起点 s 远的地方在第几跳上（0 起） */
export function hopIndexAt(path: CometPath, s: number): number {
  for (let index = 0; index < path.hopEnds.length; index += 1) if (s <= path.hopEnds[index]) return index;
  return path.hopEnds.length - 1;
}

export type CometSample = {
  head: LngLat;
  /** 尾巴的折线，从尾端到头（画渐变时 line-progress 0 是尾、1 是头） */
  tail: LngLat[];
  hop: number;
};

/**
 * 相位 → 路上的位置。飞完一趟后停 COMET_REST 这么一段（相位的比例）不显示，
 * 让人看到「到了」，再从入口重新出发；停的那段返回 null。
 */
export const COMET_REST = 0.18;

export function cometProgress(phase: number): number | null {
  const wrapped = ((phase % 1) + 1) % 1;
  const progress = wrapped / (1 - COMET_REST);
  return progress > 1 ? null : progress;
}

export function sampleComet(path: CometPath, progress: number, tailLength: number): CometSample {
  const s = Math.max(0, Math.min(1, progress)) * path.total;
  const head = pointAt(path, s);
  const start = Math.max(0, s - Math.max(0, tailLength));
  const tail: LngLat[] = [pointAt(path, start)];
  for (let index = 0; index < path.cum.length; index += 1) {
    if (path.cum[index] > start && path.cum[index] < s) tail.push(path.points[index]);
  }
  tail.push(head);
  return { head, tail, hop: hopIndexAt(path, s) };
}

/** 相位往前走：dt 毫秒 / 一趟的毫秒数，回绕到 [0, 1) */
export function advanceCometPhase(phase: number, dtMs: number, periodMs: number): number {
  if (!(periodMs > 0) || !(dtMs > 0)) return phase;
  return (((phase + dtMs / periodMs) % 1) + 1) % 1;
}

/** 一趟多久：按屏幕上的长度走，大约 110px/s，短线不快于 1.4s 一趟、长线不慢于 6s */
export const COMET_SPEED_PX_PER_S = 110;
export const COMET_MIN_PERIOD_MS = 1400;
export const COMET_MAX_PERIOD_MS = 6000;

export function cometPeriodMs(screenLengthPx: number): number {
  const raw = (screenLengthPx / COMET_SPEED_PX_PER_S) * 1000 / (1 - COMET_REST);
  return Math.max(COMET_MIN_PERIOD_MS, Math.min(COMET_MAX_PERIOD_MS, Number.isFinite(raw) ? raw : COMET_MIN_PERIOD_MS));
}

/** 墨卡托单位 ↔ 屏幕像素 */
export function mercatorUnitsPerPixel(zoom: number): number {
  return 1 / (512 * 2 ** zoom);
}
