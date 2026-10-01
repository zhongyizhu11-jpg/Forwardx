import { normalizeCountryCode } from "@/lib/countryFeatures";

/**
 * 简洁底图上的国家名：只给「有主机」的国家写，放在这个国家最大那块陆地的形心上。
 *
 * Natural Earth 110m 里没有现成的标注点（LABEL_X / LABEL_Y）也没有中文名，所以形心自己算、
 * 中文名用浏览器自带的 Intl.DisplayNames（zh-CN）—— 不另带一份国名表。香港、新加坡这些在 110m
 * 里没有面的地方就不写（主机自己的名字和国旗已经说明了）。
 *
 * 纯函数，能在 node 里测。
 */

export type LngLatPoint = [number, number];

type Ring = number[][];
type GeoFeature = { properties?: Record<string, unknown> | null; geometry?: { type?: string; coordinates?: unknown } | null };

/** 一个环的面积（带符号，按经纬度平面算，挑最大块够用）和形心 */
function ringCentroid(ring: Ring): { area: number; x: number; y: number } {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x0, y0] = ring[index];
    const [x1, y1] = ring[index + 1];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(area) < 1e-12) {
    // 退化的环：取顶点平均
    const n = Math.max(1, ring.length);
    return { area: 0, x: ring.reduce((sum, point) => sum + point[0], 0) / n, y: ring.reduce((sum, point) => sum + point[1], 0) / n };
  }
  return { area: Math.abs(area / 2), x: cx / (3 * area), y: cy / (3 * area) };
}

/** 一个国家的标注点：最大那块多边形外环的形心（美国落在本土、不落到阿拉斯加和夏威夷之间的海上） */
export function featureLabelPoint(feature: GeoFeature): LngLatPoint | null {
  const geometry = feature.geometry;
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  const polygons: Ring[][] = geometry.type === "Polygon" ? [geometry.coordinates as Ring[]] : geometry.type === "MultiPolygon" ? (geometry.coordinates as Ring[][]) : [];
  let best: { area: number; x: number; y: number } | null = null;
  for (const polygon of polygons) {
    const outer = polygon[0];
    if (!outer || outer.length < 3) continue;
    const centroid = ringCentroid(outer);
    if (!best || centroid.area > best.area) best = centroid;
  }
  return best ? [Math.round(best.x * 100) / 100, Math.round(best.y * 100) / 100] : null;
}

/** ISO 两字母代码 → 标注点。先认 ISO_A2，没有（法国、挪威是 -99）再认 WB_A2 / POSTAL / FIPS_10_ */
export function countryLabelAnchors(collection: { features?: GeoFeature[] } | null | undefined): Map<string, LngLatPoint> {
  const out = new Map<string, LngLatPoint>();
  const features = collection?.features ?? [];
  for (const pass of [["ISO_A2"], ["WB_A2", "POSTAL", "FIPS_10_"]]) {
    for (const feature of features) {
      const properties = feature.properties || {};
      const code = pass.map((field) => normalizeCountryCode(properties[field])).find(Boolean);
      if (!code || out.has(code)) continue;
      const point = featureLabelPoint(feature);
      if (point) out.set(code, point);
    }
  }
  return out;
}

let displayNames: Intl.DisplayNames | null | undefined;

/** 国家的中文名（浏览器给不出就退回传进来的名字，再不行就是代码本身） */
export function countryLabelText(code: string, fallback?: string | null): string {
  if (displayNames === undefined) {
    // fallback: "none"：不认识的代码给 undefined，不给「XQ」这种原样的代码
    try { displayNames = new Intl.DisplayNames(["zh-CN"], { type: "region", fallback: "none" }); } catch { displayNames = null; }
  }
  try {
    const name = displayNames?.of(code);
    if (name && name !== code) return name;
  } catch { /* 不认识的代码 */ }
  return fallback || code;
}
