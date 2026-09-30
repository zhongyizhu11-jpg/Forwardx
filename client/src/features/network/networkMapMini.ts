import { boxOutsideArea, boxOverlapArea, boxesIntersect, unionBox, type PixelBox, type PixelPoint } from "@shared/networkMapGeometry";

import type { NetworkMapModel } from "./networkMapModel";

/**
 * 首页那块「网络地图」小图的规则：什么时候画真地图、框哪些点、点了往哪儿跳、挨着的主机怎么
 * 并成一组、局部放大的小窗摆在哪、名字怎么躲开彼此。
 *
 * 纯函数（detectWebGL 除外），画布和卡片各自只管照着做；在 node 里能测。
 */

/** 小图框住所有主机时最多放大到这一级：两台同城的机器不该缩成一张街道图 */
export const MINI_FIT_MAX_ZOOM = 9;
/** 小图上一跳的两端在屏幕上至少隔这么远才挂延迟胶囊（整页是 110） */
export const MINI_CAP_MIN_ARC_PX = 90;
/**
 * 主图上两台主机的圆盘挨到这么近（像素）就并成一组画成一枚叠起来的 marker：26px 的盘再近就
 * 压在一起了。每台主机都画在它真正的坐标上，不再错开成环 —— 环把主机挪到上千公里外，线看着
 * 像连错了。
 */
export const MINI_GROUP_RADIUS_PX = 28;
/** 主图、小窗上 marker 离卡片边至少留这么多像素 */
export const MINI_FIT_INSET_PX = 10;
/**
 * 小窗放到 9 级还叠在一起的主机（同一机房的几台，地理库给的是同一个点）才错开一点点：
 * 9 级上 30px 不到 10 公里，说的仍是「同一个地方」。
 */
export const insetJitterRadius = (n: number) => 16 + n * 3;

// ---- 局部放大的小窗 ----

export type Quadrant = "tl" | "tr" | "bl" | "br";
export type InsetSize = { w: number; h: number };
export type InsetPlacement = { box: PixelBox; quadrant: Quadrant; shrunk: boolean };

/** 小窗多大：手机上卡片宽的 46% × 高的 48%，桌面 34% × 50%；挤不下时缩到最小 */
export function insetSizes(container: { width: number; height: number }, desktop: boolean): { full: InsetSize; min: InsetSize } {
  const full = desktop
    ? { w: Math.round(container.width * 0.34), h: Math.round(container.height * 0.5) }
    : { w: Math.round(container.width * 0.46), h: Math.round(container.height * 0.48) };
  const min = desktop
    ? { w: Math.round(container.width * 0.24), h: Math.round(container.height * 0.38) }
    : { w: Math.round(container.width * 0.36), h: Math.round(container.height * 0.36) };
  return { full, min };
}

export type MiniOccupancy = {
  /** marker、名字、胶囊占的盒子 */
  boxes: readonly PixelBox[];
  /** 弧线采样点 */
  points: readonly PixelPoint[];
};

const QUADRANTS: Quadrant[] = ["bl", "br", "tl", "tr"];

function quadrantBox(container: { width: number; height: number }, quadrant: Quadrant): PixelBox {
  const w = container.width / 2;
  const h = container.height / 2;
  return { x: quadrant.endsWith("r") ? w : 0, y: quadrant.startsWith("b") ? h : 0, w, h };
}

/** 每个象限里有多少 marker / 弧线像素：小窗摆到最空的那个去。弧线采样点按 5×5 像素算。 */
export function scoreQuadrants(container: { width: number; height: number }, occupancy: MiniOccupancy): Record<Quadrant, number> {
  const scores = { tl: 0, tr: 0, bl: 0, br: 0 };
  for (const quadrant of QUADRANTS) {
    const area = quadrantBox(container, quadrant);
    let score = 0;
    for (const box of occupancy.boxes) score += boxOverlapArea(box, area);
    for (const point of occupancy.points) score += boxOverlapArea({ x: point.x - 2.5, y: point.y - 2.5, w: 5, h: 5 }, area);
    scores[quadrant] = score;
  }
  return scores;
}

function cornerBox(container: { width: number; height: number }, quadrant: Quadrant, size: InsetSize, margin: number): PixelBox {
  return {
    x: quadrant.endsWith("r") ? container.width - margin - size.w : margin,
    y: quadrant.startsWith("b") ? container.height - margin - size.h : margin,
    w: size.w,
    h: size.h,
  };
}

/**
 * 小窗摆哪：象限按空的程度排（一样空时左下优先），先试标准尺寸，四个角都压到 marker 就缩到
 * 最小尺寸再试；还是没有空位就挑压得最少的角。第二个小窗（桌面）还要躲开第一个。
 */
export function placeInsets(
  container: { width: number; height: number },
  occupancy: MiniOccupancy,
  count: number,
  desktop: boolean,
  margin = MINI_FIT_INSET_PX,
): InsetPlacement[] {
  const placed: InsetPlacement[] = [];
  if (count <= 0 || container.width < 40 || container.height < 40) return placed;
  const scores = scoreQuadrants(container, occupancy);
  const order = [...QUADRANTS].sort((a, b) => scores[a] - scores[b] || QUADRANTS.indexOf(a) - QUADRANTS.indexOf(b));
  const sizes = insetSizes(container, desktop);
  for (let index = 0; index < count; index += 1) {
    const blocked = [...occupancy.boxes, ...placed.map((item) => item.box)];
    let choice: InsetPlacement | null = null;
    for (const size of [sizes.full, sizes.min]) {
      for (const quadrant of order) {
        const box = cornerBox(container, quadrant, size, margin);
        if (placed.some((item) => item.quadrant === quadrant)) continue;
        if (blocked.some((other) => boxesIntersect(box, other))) continue;
        choice = { box, quadrant, shrunk: size === sizes.min };
        break;
      }
      if (choice) break;
    }
    if (!choice) {
      // 没有空角：最小尺寸放到压得最少的角
      let best: InsetPlacement | null = null;
      let bestArea = Infinity;
      for (const quadrant of order) {
        if (placed.some((item) => item.quadrant === quadrant)) continue;
        const box = cornerBox(container, quadrant, sizes.min, margin);
        const area = blocked.reduce((sum, other) => sum + boxOverlapArea(box, other), 0);
        if (area < bestArea) { bestArea = area; best = { box, quadrant, shrunk: true }; }
      }
      if (!best) break;
      choice = best;
    }
    placed.push(choice);
  }
  return placed;
}

/** 一组主机在主图上盖住的范围：成员真实位置的外接框并上叠起来的 marker，再让出几像素 */
export function groupCoverageBox(points: readonly PixelPoint[], markerBox: PixelBox | null, pad = 5): PixelBox | null {
  const boxes: PixelBox[] = points.map((point) => ({ x: point.x, y: point.y, w: 0, h: 0 }));
  if (markerBox) boxes.push(markerBox);
  const union = unionBox(boxes);
  if (!union) return null;
  return { x: union.x - pad, y: union.y - pad, w: union.w + pad * 2, h: union.h + pad * 2 };
}

/** 哪些组开小窗：最大的那几组（至少两台），手机 1 个、桌面 2 个 */
export function pickInsetGroups<T extends { hostIds: number[] }>(groups: readonly T[], desktop: boolean): T[] {
  return groups
    .filter((group) => group.hostIds.length >= 2)
    .sort((a, b) => b.hostIds.length - a.hostIds.length || a.hostIds[0] - b.hostIds[0])
    .slice(0, desktop ? 2 : 1);
}

// ---- 名字怎么摆 ----

export type LabelItem = {
  key: string;
  /** marker 的锚点（屏幕像素） */
  x: number;
  y: number;
  /** 名字元素量出来的尺寸 */
  w: number;
  h: number;
  /** 缩到 9.5px 后的宽度 */
  tightW: number;
  /** 名字离锚点多远（圆盘半径 + 一点缝） */
  gap: number;
  /** 先试上面还是下面（环上朝外的那一侧；默认下面） */
  preferUp?: boolean;
};

export type LabelPlacement = { key: string; up: boolean; dx: number; tight: boolean; box: PixelBox };

const LABEL_SHIFTS = [0, -4, 4, -8, 8, -14, 14];

/**
 * 小图上主机名的摆法：默认在圆盘下面（环上的点朝外）；会压到别的名字、圆盘、胶囊或露出卡片
 * 边时依次试：翻到另一侧 → 左右挪最多 14px → 缩小一号字。按从上到下的顺序贪心放，先放的
 * 名字成为后面的障碍。挑不出一个完全干净的位置时选压得最少的。
 */
export function placeLabelBoxes(items: readonly LabelItem[], obstacles: readonly PixelBox[], area: PixelBox): LabelPlacement[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const placedBoxes: PixelBox[] = [];
  const result: LabelPlacement[] = [];
  for (const item of sorted) {
    let best: LabelPlacement | null = null;
    let bestScore = Infinity;
    for (const tight of [false, true]) {
      const w = tight ? item.tightW : item.w;
      const half = w / 2;
      // 贴着卡片边的先往里挪，再在这个基础上左右试
      let edge = 0;
      if (item.x - half < area.x + 2) edge = area.x + 2 - (item.x - half);
      else if (item.x + half > area.x + area.w - 2) edge = area.x + area.w - 2 - (item.x + half);
      const sides = item.preferUp ? [true, false] : [false, true];
      for (const shift of LABEL_SHIFTS) {
        for (const up of sides) {
          const dx = edge + shift;
          const box: PixelBox = { x: item.x - half + dx, y: up ? item.y - item.gap - item.h : item.y + item.gap, w, h: item.h };
          let score = boxOutsideArea(box, area) * 3;
          for (const other of obstacles) score += boxOverlapArea(box, other);
          for (const other of placedBoxes) score += boxOverlapArea(box, other);
          // 完全干净就要它；否则记着最好的，缩小字号只在没有干净位置时才用
          if (score < bestScore - 1e-9) { bestScore = score; best = { key: item.key, up, dx, tight, box }; }
          if (score === 0) break;
        }
        if (bestScore === 0) break;
      }
      if (bestScore === 0) break;
    }
    if (!best) continue;
    placedBoxes.push(best.box);
    result.push(best);
  }
  return result;
}

export function locatedHostCount(model: Pick<NetworkMapModel, "nodes">): number {
  return model.nodes.filter((node) => !!node.geo).length;
}

export function unlocatedHostCount(model: Pick<NetworkMapModel, "nodes">): number {
  return model.nodes.length - locatedHostCount(model);
}

/** 要框住的点：主机；开了落地流向再加上定位到的目标 */
export function miniFitPoints(model: Pick<NetworkMapModel, "nodes" | "targets">, showFlows: boolean): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (const node of model.nodes) if (node.geo) points.push([node.geo.lng, node.geo.lat]);
  if (showFlows) for (const target of model.targets) if (target.geo) points.push([target.geo.lng, target.geo.lat]);
  return points;
}

/**
 * 画真地图还是留着原来的 SVG 示意图：没有 WebGL（远程桌面、老浏览器）或者一台主机都
 * 没定位时，真地图上什么都摆不出来，示意图反而能把「谁连着谁」说清楚。
 */
export function shouldRenderRealMap(input: { webgl: boolean; locatedHosts: number }): boolean {
  return input.webgl && input.locatedHosts > 0;
}

/** 小图上点了主机 / 线路要跳去的整页地址（整页一打开就弹那个详情） */
export function miniOpenHref(target: { kind: "host" | "link"; id: number } | null): string {
  if (!target) return "/map";
  return target.kind === "host" ? `/map?host=${target.id}` : `/map?link=${target.id}`;
}

let webglSupported: boolean | null = null;

/**
 * 这个浏览器建不建得出 WebGL 上下文。只测一次：建上下文不便宜，而且答案不会变。
 * 没有 document（node）当不支持。
 */
export function detectWebGL(): boolean {
  if (webglSupported !== null) return webglSupported;
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    webglSupported = !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    webglSupported = false;
  }
  return webglSupported;
}
