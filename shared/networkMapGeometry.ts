/**
 * 网络地图的几何：大圆弧、簇与错开。
 *
 * 纯函数，不碰 MapLibre —— 投影（经纬度 → 像素）由调用方传进来，这样能在 node 里测，
 * 也不用为了算一次布局去 mock 一整个地图。
 */

export type LngLat = [number, number];

/**
 * 两点之间的大圆弧，n 段折线。
 *
 * 直线在墨卡托上看着像航线图里没有的东西；大圆弧是飞机真正飞的路，广州 → 洛杉矶
 * 会往北弯过阿留申群岛，一眼就是「跨太平洋」。
 *
 * 越过日界线时把后面的点连续化（±360），否则 MapLibre 会画一条横跨整个地球的线。
 */
export function greatCircleArc(a: LngLat, b: LngLat, n = 40): LngLat[] {
  const toR = Math.PI / 180;
  const toD = 180 / Math.PI;
  const l1 = a[0] * toR;
  const p1 = a[1] * toR;
  const l2 = b[0] * toR;
  const p2 = b[1] * toR;
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (!(d > 1e-7)) return [a, b];
  const pts: LngLat[] = [];
  for (let i = 0; i <= n; i += 1) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    pts.push([Math.atan2(y, x) * toD, Math.atan2(z, Math.sqrt(x * x + y * y)) * toD]);
  }
  for (let k = 1; k < pts.length; k += 1) {
    while (pts[k][0] - pts[k - 1][0] > 180) pts[k][0] -= 360;
    while (pts[k][0] - pts[k - 1][0] < -180) pts[k][0] += 360;
  }
  // 起点按原样对齐到 a 所在的那一圈，整条线才和两端的 marker 在同一份世界副本上。
  const shift = a[0] - pts[0][0];
  if (Math.abs(shift) > 1e-9) for (const p of pts) p[0] += shift;
  return pts;
}

export type LayoutPoint = { key: string; lngLat: LngLat };

export type LayoutPosition = {
  /** marker 要放的经纬度：单独的点是自己，簇 / 环里的点是组的中心 */
  lngLat: LngLat;
  /** 像素偏移：错开成环时不为零 */
  offset: [number, number];
  /** 归在哪个簇里（只在 cluster 模式且组里不止一个点时有值） */
  clusterId: number | null;
};

export type LayoutGroup = { id: number; keys: string[]; center: LngLat; cx: number; cy: number };

export type MapLayout = {
  mode: "cluster" | "spread";
  /** cluster 模式下不止一个点的组 —— 这些要画成一枚簇 pill */
  groups: LayoutGroup[];
  pos: Record<string, LayoutPosition>;
};

/** 6 级以下聚簇，以上错开 —— 6 级刚好是「一个省 / 一个大城市圈」能分开的尺度。 */
export const CLUSTER_MAX_ZOOM = 6;
export const CLUSTER_RADIUS_PX = 44;
export const SPREAD_RADIUS_PX = 30;

/**
 * 按屏幕像素距离分组：44px 以内聚成簇（缩小时），30px 以内错开成一圈（放大时）。
 *
 * 贪心：按顺序把每个点归到第一个够近的组里，组心随之更新。点少（几十上百）时够用，
 * 而且是确定的 —— 同样的输入永远得到同样的簇，marker 不会在两次 relayout 之间跳。
 */
export function computeMapLayout(
  points: readonly LayoutPoint[],
  project: (lngLat: LngLat) => { x: number; y: number },
  zoom: number,
  options: { /** 首页那块小图：永远不聚簇，挨着的点错开成环，每台主机都看得见 */ spreadOnly?: boolean } = {},
): MapLayout {
  const mode: MapLayout["mode"] = !options.spreadOnly && zoom < CLUSTER_MAX_ZOOM ? "cluster" : "spread";
  const radius = mode === "cluster" ? CLUSTER_RADIUS_PX : SPREAD_RADIUS_PX;
  const groups: Array<{ items: LayoutPoint[]; px: Array<{ x: number; y: number }>; cx: number; cy: number }> = [];
  for (const p of points) {
    const pt = project(p.lngLat);
    let group = null as (typeof groups)[number] | null;
    for (const g of groups) {
      if (Math.hypot(g.cx - pt.x, g.cy - pt.y) < radius) { group = g; break; }
    }
    if (!group) { groups.push({ items: [p], px: [pt], cx: pt.x, cy: pt.y }); continue; }
    group.items.push(p);
    group.px.push(pt);
    group.cx = group.px.reduce((s, q) => s + q.x, 0) / group.px.length;
    group.cy = group.px.reduce((s, q) => s + q.y, 0) / group.px.length;
  }
  const pos: Record<string, LayoutPosition> = {};
  const outGroups: LayoutGroup[] = [];
  groups.forEach((g, gi) => {
    const center: LngLat = [
      g.items.reduce((s, it) => s + it.lngLat[0], 0) / g.items.length,
      g.items.reduce((s, it) => s + it.lngLat[1], 0) / g.items.length,
    ];
    if (g.items.length === 1) {
      pos[g.items[0].key] = { lngLat: g.items[0].lngLat, offset: [0, 0], clusterId: null };
      return;
    }
    if (mode === "cluster") {
      for (const it of g.items) pos[it.key] = { lngLat: center, offset: [0, 0], clusterId: gi };
      outGroups.push({ id: gi, keys: g.items.map((it) => it.key), center, cx: g.cx, cy: g.cy });
      return;
    }
    // 错开成一圈：半径随点数长一点，四台以上不会挤成一团
    const n = g.items.length;
    const R = 24 + n * 4;
    g.items.forEach((it, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      pos[it.key] = { lngLat: center, offset: [Math.round(Math.cos(angle) * R), Math.round(Math.sin(angle) * R)], clusterId: null };
    });
  });
  return { mode, groups: outGroups, pos };
}

/**
 * 一组点的外接范围，给 fitBounds 用。
 *
 * 越过日界线的点挪到 +360 那一侧，保证太平洋在中间、线不会绕地球一圈；
 * 单点或很近的点撑开 0.6°，否则 fitBounds 会放大到最大级别。
 */
export function boundsForPoints(points: readonly LngLat[]): [[number, number], [number, number]] | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    const x = p[0] < -30 ? p[0] + 360 : p[0];
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  if (maxX - minX < 0.6) { minX -= 0.3; maxX += 0.3; }
  if (maxY - minY < 0.6) { minY -= 0.3; maxY += 0.3; }
  return [[minX, minY], [maxX, maxY]];
}

export type PixelPoint = { x: number; y: number };

/**
 * 弧线末端的箭头（屏幕像素里的三角形）：让方向不靠动画也看得出来。
 *
 * 方向取弧线最后一小段的切线 —— 从末端往回找到离末端至少 minTangentPx 远的顶点再算，
 * 缩到全球时最后一段可能不到一像素，直接用它方向会抖。backoff 把箭尖从主机的圆盘下
 * 挪出来，不然盘子把箭头盖住。太短的弧（整条不到 minTangentPx）不画，返回 null。
 * 返回 [箭尖, 左底角, 右底角]。
 */
export function arrowTriangleAlong(projected: readonly PixelPoint[], size: number, backoff: number, minTangentPx = 8): [PixelPoint, PixelPoint, PixelPoint] | null {
  if (projected.length < 2) return null;
  const tip = projected[projected.length - 1];
  let from: PixelPoint | null = null;
  for (let index = projected.length - 2; index >= 0; index -= 1) {
    if (Math.hypot(tip.x - projected[index].x, tip.y - projected[index].y) >= minTangentPx) { from = projected[index]; break; }
  }
  if (!from) return null;
  const length = Math.hypot(tip.x - from.x, tip.y - from.y);
  const dx = (tip.x - from.x) / length;
  const dy = (tip.y - from.y) / length;
  const apex = { x: tip.x - dx * backoff, y: tip.y - dy * backoff };
  const base = { x: apex.x - dx * size, y: apex.y - dy * size };
  const half = size * 0.55;
  return [apex, { x: base.x - dy * half, y: base.y + dx * half }, { x: base.x + dy * half, y: base.y - dx * half }];
}
