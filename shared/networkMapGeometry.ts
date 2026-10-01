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
  /**
   * 扇开了（computeFanLayout）：marker 画在 lngLat 投影点 + offset，lngLat 是它真正的位置 ——
   * 画布从圆盘到真实位置拉一根细线，看得出几台其实在同一个地方
   */
  fanned?: boolean;
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

export type MapLayoutOptions = {
  /** 首页那块小图：永远不聚簇，挨着的点错开成环，每台主机都看得见（等于 mode: "spread"） */
  spreadOnly?: boolean;
  /** 不按级别自动切：cluster 永远聚、spread 永远错开 */
  mode?: "auto" | "cluster" | "spread";
  /** 离组心多近算一组（像素）；不传按上面两个常量 */
  clusterRadius?: number;
  spreadRadius?: number;
  /** 错开成环时的半径：n 个点时多大（像素） */
  ringRadius?: (n: number) => number;
  /**
   * 聚簇之后再吸一遍：单独的点离某个组的组心 (dx, dy) 像素时要不要并进去。簇 pill 比圆盘宽
   * （几面旗 + 数量），按圆心距离分组会让紧挨着 pill 右边的那台压在 pill 上；调用方知道 pill
   * 多宽，由它来判断。只在 cluster 模式下用。
   */
  absorb?: (groupKeys: string[], offset: { dx: number; dy: number }) => boolean;
};

/** 默认的环半径：随点数长一点，四台以上不会挤成一团 */
export const defaultRingRadius = (n: number) => 24 + n * 4;

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
  options: MapLayoutOptions = {},
): MapLayout {
  const forced = options.mode ?? (options.spreadOnly ? "spread" : "auto");
  const mode: MapLayout["mode"] = forced === "auto" ? (zoom < CLUSTER_MAX_ZOOM ? "cluster" : "spread") : forced;
  const radius = mode === "cluster" ? options.clusterRadius ?? CLUSTER_RADIUS_PX : options.spreadRadius ?? SPREAD_RADIUS_PX;
  const ringRadius = options.ringRadius ?? defaultRingRadius;
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
  if (mode === "cluster" && options.absorb) {
    // 组心会随着吸进来的点挪，挪完可能又够到下一台，所以吸到没有变化为止（最多点数那么多轮）
    for (let changed = true; changed;) {
      changed = false;
      for (let i = 0; i < groups.length && !changed; i += 1) {
        const single = groups[i];
        if (single.items.length !== 1) continue;
        for (const g of groups) {
          if (g === single || g.items.length < 2) continue;
          if (!options.absorb(g.items.map((it) => it.key), { dx: single.px[0].x - g.cx, dy: single.px[0].y - g.cy })) continue;
          g.items.push(single.items[0]);
          g.px.push(single.px[0]);
          g.cx = g.px.reduce((s, q) => s + q.x, 0) / g.px.length;
          g.cy = g.px.reduce((s, q) => s + q.y, 0) / g.px.length;
          groups.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
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
    // 错开成一圈
    const n = g.items.length;
    const R = ringRadius(n);
    g.items.forEach((it, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      pos[it.key] = { lngLat: center, offset: [Math.round(Math.cos(angle) * R), Math.round(Math.sin(angle) * R)], clusterId: null };
    });
  });
  return { mode, groups: outGroups, pos };
}

export type FanLayoutOptions = {
  /** 圆盘多大（像素）：屏幕上两台离得比它近（包括坐标一模一样）就算叠着，要扇开 */
  discSize: number;
  /** 两台并排时圆心隔多远（默认 22） */
  pairGap?: number;
  /** 3 ~ maxFan 台围成一圈的半径（默认 3 台 16px，每多一台 +2，6 台 22px） */
  ringRadius?: (n: number) => number;
  /** 最多扇开几台，再多就留一枚带数量的 pill（默认 6） */
  maxFan?: number;
  /** 扇出去的圆盘要落在这个框里（小窗让出边距后的范围）：贴边的那组整组往里挪，细线照样连回真实位置 */
  bounds?: PixelBox;
};

/** 默认的扇开半径：3 台 16px、4 台 18px、5 台 20px、6 台 22px —— 相邻两台的弦长都比 20px 的圆盘宽 */
export const defaultFanRingRadius = (n: number) => 16 + Math.max(0, Math.min(6, n) - 3) * 2;

/** 主机 key（「h12」）按里面的数字排，没有数字的按字面：同一组里谁在左、谁在圈顶永远一样 */
function compareLayoutKeys(a: string, b: string): number {
  const na = Number(a.replace(/^\D+/, ""));
  const nb = Number(b.replace(/^\D+/, ""));
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 小窗里的布局：每台主机都画出来、各带自己的名字，不并成「2」那种 pill。
 *
 * 首页小窗是为了把主图上叠在一起的几台分开看的；可两台机器的坐标一模一样（同一个机房、IP 定位到同一个
 * 城市中心）时，放多大都还是叠着，以前就并成一枚写着「2」的 pill，窗里一个主机名都看不到。这里把屏幕上
 * 比圆盘还近的几台（单链：A 挨着 B、B 挨着 C 就是一组）围着它们的中心扇开：
 *   2 台      左右并排，圆心隔 22px（id 小的在左）
 *   3 ~ 6 台  围一圈，半径 16 ~ 22px，从正上方顺时针按 id 排
 *   更多      留一枚带数量的 pill（clusterId），再扇就成一团了
 * 扇开之后要是和别的组 / 单独的点压在一起，就并成一组重新扇，直到谁都不压谁。给了 bounds 时，露出框的
 * 那组整组往里挪。每台的 lngLat 还是它真正的位置，偏移量放在 offset 里（fanned = true），画布据此从圆盘
 * 拉一根细线回真实位置。
 *
 * 和 computeMapLayout 一样是纯函数、确定的：同样的输入永远同样的摆法。
 */
export function computeFanLayout(
  points: readonly LayoutPoint[],
  project: (lngLat: LngLat) => { x: number; y: number },
  options: FanLayoutOptions,
): MapLayout {
  const disc = options.discSize;
  const pairGap = options.pairGap ?? 22;
  const ringRadius = options.ringRadius ?? defaultFanRingRadius;
  const maxFan = options.maxFan ?? 6;
  const sorted = [...points].sort((a, b) => compareLayoutKeys(a.key, b.key));
  const px = sorted.map((point) => project(point.lngLat));
  const n = sorted.length;
  // 并查集：组的代表是组里下标最小的那个
  const parent = sorted.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) if (Math.hypot(px[i].x - px[j].x, px[i].y - px[j].y) < disc) union(i, j);
  }
  type Placed = { members: number[]; at: Array<{ x: number; y: number }>; pill: boolean; cx: number; cy: number };
  const placeGroups = (): Placed[] => {
    const byRoot = new Map<number, number[]>();
    for (let i = 0; i < n; i += 1) {
      const root = find(i);
      const list = byRoot.get(root);
      if (list) list.push(i); else byRoot.set(root, [i]);
    }
    const out: Placed[] = [];
    for (const members of [...byRoot.values()].sort((a, b) => a[0] - b[0])) {
      const cx = members.reduce((sum, index) => sum + px[index].x, 0) / members.length;
      const cy = members.reduce((sum, index) => sum + px[index].y, 0) / members.length;
      const count = members.length;
      let at: Array<{ x: number; y: number }>;
      if (count === 1) at = [{ x: px[members[0]].x, y: px[members[0]].y }];
      else if (count > maxFan) at = members.map(() => ({ x: cx, y: cy }));
      else if (count === 2) at = [{ x: cx - pairGap / 2, y: cy }, { x: cx + pairGap / 2, y: cy }];
      else {
        const radius = ringRadius(count);
        at = members.map((_, k) => {
          const angle = -Math.PI / 2 + (k * 2 * Math.PI) / count;
          return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
        });
      }
      if (count > 1 && options.bounds) {
        // 露出框的整组往里挪（框比这组还小就居中）
        const half = disc / 2;
        const minX = Math.min(...at.map((p) => p.x)) - half;
        const maxX = Math.max(...at.map((p) => p.x)) + half;
        const minY = Math.min(...at.map((p) => p.y)) - half;
        const maxY = Math.max(...at.map((p) => p.y)) + half;
        const b = options.bounds;
        const shift = (lo: number, hi: number, from: number, to: number) => (hi - lo > to - from ? (from + to) / 2 - (lo + hi) / 2 : lo < from ? from - lo : hi > to ? to - hi : 0);
        const dx = shift(minX, maxX, b.x, b.x + b.w);
        const dy = shift(minY, maxY, b.y, b.y + b.h);
        if (dx || dy) at = at.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      }
      out.push({ members, at: at.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 })), pill: count > maxFan, cx, cy });
    }
    return out;
  };
  let placed = placeGroups();
  // 扇开后压到别的组：并起来重扇。每轮至少少一组，最多 n 轮
  for (let round = 0; round < n; round += 1) {
    let merged = false;
    for (let a = 0; a < placed.length && !merged; a += 1) {
      for (let b = a + 1; b < placed.length && !merged; b += 1) {
        const ga = placed[a];
        const gb = placed[b];
        const hit = ga.at.some((p) => gb.at.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < disc - 1e-6));
        if (hit) { union(ga.members[0], gb.members[0]); merged = true; }
      }
    }
    if (!merged) break;
    placed = placeGroups();
  }
  const pos: Record<string, LayoutPosition> = {};
  const groups: LayoutGroup[] = [];
  placed.forEach((group, gi) => {
    if (group.pill) {
      const center: LngLat = [
        group.members.reduce((sum, index) => sum + sorted[index].lngLat[0], 0) / group.members.length,
        group.members.reduce((sum, index) => sum + sorted[index].lngLat[1], 0) / group.members.length,
      ];
      for (const index of group.members) pos[sorted[index].key] = { lngLat: center, offset: [0, 0], clusterId: gi };
      groups.push({ id: gi, keys: group.members.map((index) => sorted[index].key), center, cx: group.cx, cy: group.cy });
      return;
    }
    group.members.forEach((index, k) => {
      const offset: [number, number] = [Math.round((group.at[k].x - px[index].x) * 10) / 10, Math.round((group.at[k].y - px[index].y) * 10) / 10];
      const fanned = group.members.length > 1;
      pos[sorted[index].key] = { lngLat: sorted[index].lngLat, offset: fanned ? offset : [0, 0], clusterId: null, ...(fanned ? { fanned: true } : {}) };
    });
  });
  return { mode: "spread", groups, pos };
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
export function arrowTriangleAlong(projected: readonly PixelPoint[], size: number, backoff: number, minTangentPx = 8, widthRatio = 0.55): [PixelPoint, PixelPoint, PixelPoint] | null {
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
  // 两腰离中线多远（相对箭长）：默认 0.55 是个胖三角；地图上用 0.4，细而尖
  const half = size * widthRatio;
  return [apex, { x: base.x - dy * half, y: base.y + dx * half }, { x: base.x + dy * half, y: base.y - dx * half }];
}

export type PixelBox = { x: number; y: number; w: number; h: number };

export function boxesIntersect(a: PixelBox, b: PixelBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 两个盒子重叠的面积（不重叠是 0） */
export function boxOverlapArea(a: PixelBox, b: PixelBox): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 盒子露在区域外面的面积 */
export function boxOutsideArea(box: PixelBox, area: PixelBox): number {
  return box.w * box.h - boxOverlapArea(box, area);
}

export function unionBox(boxes: readonly PixelBox[]): PixelBox | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x); minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w); maxY = Math.max(maxY, box.y + box.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export type FitItem = {
  /** 随缩放走的那个点：经纬度投影出来的像素（环上的点也是簇心，不含像素偏移） */
  anchor: PixelPoint;
  /** 画出来占的屏幕盒子：圆盘 + 名字 + 环偏移这些不随缩放变的部分都算在内 */
  box: PixelBox;
};

export type FitInset = { top: number; right: number; bottom: number; left: number };

export type FitResult = {
  /** 地图要乘的比例：< 1 缩小、> 1 放大 */
  scale: number;
  /** 等价的 zoom 增量（log2 scale） */
  zoomDelta: number;
  /** 现在屏幕上的这个点变换后应该落在容器正中 —— 反投影它就是新的 center */
  centerPx: PixelPoint;
  /** 按这个比例所有盒子都能放进留白之内（放不进说明缩到 minScale 也不够） */
  fits: boolean;
};

/**
 * 把一批 marker 完整框进容器：算出该缩放多少、中心挪到哪。
 *
 * fitBounds 只知道经纬度，不知道圆盘有 26px、名字有 90px 宽、环上的点还往外偏了 40px ——
 * 这些像素尺寸不随缩放变，于是贴边的主机总被裁掉半个盘。这里把每个 marker 拆成「随缩放
 * 走的锚点」和「不随缩放变的盒子边距」：整体宽度 W(k) = max(k·ax + 右边距) − min(k·ax − 左边距)
 * 是 k 的凸函数，二分就能找到最大的还放得下的 k（放得下就往里放大到 maxScale，放不下
 * 就缩小）。然后把所有盒子的并集挪到留白区域正中。
 *
 * 返回的是「当前屏幕上哪个点该成为新中心」+ 缩放比例；调用方 jumpTo(unproject(centerPx), zoom + zoomDelta)
 * 一次到位。marker 的分组随缩放会变（缩小后两台并成一组），所以调用方量一次、跳一次、再量一次，
 * 几轮就收敛。
 */
export function fitViewToBoxes(
  container: { width: number; height: number },
  items: readonly FitItem[],
  inset: FitInset,
  options: { /** 最多放大到这个比例（默认 1：只缩不放） */ maxScale?: number; /** 最多缩小到这个比例（默认 0） */ minScale?: number } = {},
): FitResult | null {
  if (items.length === 0) return null;
  const maxScale = Math.max(options.maxScale ?? 1, 1e-6);
  const minScale = Math.min(Math.max(options.minScale ?? 0, 0), maxScale);
  const availW = Math.max(1, container.width - inset.left - inset.right);
  const availH = Math.max(1, container.height - inset.top - inset.bottom);
  const c0 = { x: container.width / 2, y: container.height / 2 };
  const parts = items.map((item) => ({
    ax: item.anchor.x - c0.x, ay: item.anchor.y - c0.y,
    l: item.anchor.x - item.box.x, r: item.box.x + item.box.w - item.anchor.x,
    t: item.anchor.y - item.box.y, b: item.box.y + item.box.h - item.anchor.y,
  }));
  const extent = (k: number) => {
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (const p of parts) {
      minX = Math.min(minX, k * p.ax - p.l); maxX = Math.max(maxX, k * p.ax + p.r);
      minY = Math.min(minY, k * p.ay - p.t); maxY = Math.max(maxY, k * p.ay + p.b);
    }
    return { minX, maxX, minY, maxY };
  };
  const feasible = (k: number) => { const e = extent(k); return e.maxX - e.minX <= availW && e.maxY - e.minY <= availH; };
  let scale: number;
  let fits = true;
  if (feasible(maxScale)) scale = maxScale;
  else if (!feasible(minScale)) { scale = minScale; fits = false; }
  else {
    let lo = minScale;
    let hi = maxScale;
    for (let i = 0; i < 48; i += 1) {
      const mid = (lo + hi) / 2;
      if (feasible(mid)) lo = mid; else hi = mid;
    }
    scale = lo;
  }
  const e = extent(scale);
  // 并集（相对容器中心）的中点要挪到留白区域的中点
  const unionCenter = { x: (e.minX + e.maxX) / 2, y: (e.minY + e.maxY) / 2 };
  const target = { x: inset.left + availW / 2 - c0.x, y: inset.top + availH / 2 - c0.y };
  const pan = { x: target.x - unionCenter.x, y: target.y - unionCenter.y };
  // 变换：p' = c0 + k(p − c0) + pan；要让 q 变到 c0：q = c0 − pan / k
  return {
    scale,
    zoomDelta: Math.log2(scale),
    centerPx: { x: c0.x - pan.x / scale, y: c0.y - pan.y / scale },
    fits,
  };
}

/**
 * 两个盒子之间的引线：从各自中心连一条线，掐掉落在盒子里面的两截。盒子挨着 / 套着时不画（null）。
 */
export function leaderBetweenBoxes(from: PixelBox, to: PixelBox): [PixelPoint, PixelPoint] | null {
  const a = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const b = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.hypot(dx, dy) < 1e-6) return null;
  const exitT = (box: PixelBox) => Math.min(dx === 0 ? Infinity : (box.w / 2) / Math.abs(dx), dy === 0 ? Infinity : (box.h / 2) / Math.abs(dy));
  const tA = exitT(from);
  const tB = 1 - exitT(to);
  if (!(tA < tB)) return null;
  return [{ x: a.x + dx * tA, y: a.y + dy * tA }, { x: a.x + dx * tB, y: a.y + dy * tB }];
}
