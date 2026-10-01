import { describeNetworkHealth, type NetworkHealth } from "@shared/networkHealth";
import { boxOutsideArea, boxOverlapArea, type MapLayoutOptions, type PixelBox } from "@shared/networkMapGeometry";

import type { NetworkMapModel } from "./networkMapModel";

/**
 * 首页那张「网络地图」的规则：什么时候画真地图、什么时候重新框、挨着的主机怎么并成一组、
 * 名字怎么躲开彼此、点一下提示什么字。
 *
 * 纯函数（detectWebGL 除外），画布和卡片各自只管照着做；在 node 里能测。
 */

/** 小图框住所有主机时最多放大到这一级：两台同城的机器不该缩成一张街道图 */
export const MINI_FIT_MAX_ZOOM = 9;
/**
 * 一跳的两端在屏幕上至少隔这么远才在线的正中挂中断的 ⊗：卡片就巴掌大，短的那几跳挂上只会
 * 压着主机和名字（线本身已经是红虚线，点线时的提示里也写着中断）。
 */
export const MINI_CAP_MIN_ARC_PX = 110;
/**
 * 主图上两台主机的圆盘挨到这么近（像素）就并成一组画成一枚叠起来的 marker：26px 的盘再近就
 * 压在一起了。每台主机都画在它真正的坐标上，不再错开成环 —— 环把主机挪到上千公里外，线看着
 * 像连错了。
 */
export const MINI_GROUP_RADIUS_PX = 28;
/**
 * 叠起来的 marker 大概多宽：一摞 16px 的国旗（第二面起每面只露 10px）+ 压上去 4px 的数量小牌
 * （18px 起，数字多一位宽 6.5px）。和 networkMap.css 里 .nm-mini .nm-mk-cluster 的尺寸对上。按圆心
 * 距离分组够不着、但主机的点会压在这一摞上的那台也并进组（computeMapLayout 的 absorb）。
 */
export function estimateGroupPillWidth(flags: number, count: number): number {
  return 16 + 10 * (Math.min(3, Math.max(1, flags)) - 1) - 4 + Math.max(18, 10 + 6.5 * String(count).length);
}
/** 单独一台离组心多近会压到这一摞：半宽 / 半高（数量牌 18px 高）+ 主机盒子的半径 + 一点缝 */
export function shouldAbsorbIntoGroup(flags: number, count: number, offset: { dx: number; dy: number }): boolean {
  return Math.abs(offset.dx) < estimateGroupPillWidth(flags, count) / 2 + 13 + 4 && Math.abs(offset.dy) < 9 + 13 + 4;
}
/**
 * 并组规则：28px 内的并成一组，圆盘会压到组的环上的那台也并进去。
 * flagOf：layout 点的 key → 这台的旗（estimateGroupPillWidth 按旗数估宽，估得只会偏宽、并得只会偏早）。
 */
export function miniGroupLayoutOptions(flagOf: ReadonlyMap<string, string | null | undefined>): MapLayoutOptions {
  return {
    clusterRadius: MINI_GROUP_RADIUS_PX,
    absorb: (keys, offset) => shouldAbsorbIntoGroup(new Set(keys.map((key) => flagOf.get(key)).filter(Boolean)).size, keys.length + 1, offset),
  };
}

/** 一组主机的地名：去重后的城市，最多三个（组的环下面、点组时的提示都这么写） */
export function groupPlaceLabel(cities: readonly string[]): string {
  const unique: string[] = [];
  for (const city of cities) if (city && !unique.includes(city)) unique.push(city);
  return unique.slice(0, 3).join(" · ");
}

/** marker 离卡片边至少留这么多像素 */
export const MINI_FIT_INSET_PX = 10;

// ---- 用户能拖能缩之后：什么时候还自动框、能缩到多小 ----

/** 为什么要重新框住全部主机 */
export type MiniFitTrigger = "initial" | "resize" | "hosts" | "reset";

/**
 * 要不要重新框：首次、点「回到全览」一定框；卡片变宽变窄、主机多了少了一台只在用户没动过图
 * 时框 —— 用户刚拖到想看的地方，轮询回来多了台主机就把视角抢回去，比不框糟得多。
 */
export function shouldRefit(trigger: MiniFitTrigger, userMoved: boolean): boolean {
  return trigger === "initial" || trigger === "reset" || !userMoved;
}

/** 用户最多能缩到多小：框住全部之后再缩一级，别缩成一条世界的细带子 */
export function miniMinZoom(fittedZoom: number): number {
  return Math.max(0, fittedZoom - 1);
}

// ---- 点一下的提示（哪儿都不跳，只说一句是谁）----

/** 主机：「HK entry 01 · 香港 · 在线」 */
export function hostTipText(node: { name: string; region: string | null; city: string; isOnline: boolean }): string {
  const place = node.region || node.city;
  return [node.name, place && place !== node.name ? place : null, node.isOnline ? "在线" : "离线"].filter(Boolean).join(" · ");
}

/** 线路：「HK → JP · 46 ms」；没测过延迟就写状态 */
export function linkTipText(link: { path: number[]; latencyMs?: number | null; health: NetworkHealth }, nodes: ReadonlyArray<{ id: number; name: string }>): string {
  const nameOf = (id: number) => nodes.find((node) => node.id === id)?.name || `#${id}`;
  const ends = link.path.length >= 2 ? `${nameOf(link.path[0])} → ${nameOf(link.path[link.path.length - 1])}` : nameOf(link.path[0] ?? 0);
  const tail = typeof link.latencyMs === "number" ? `${Math.round(link.latencyMs)} ms` : describeNetworkHealth(link.health).label;
  return `${ends} · ${tail}`;
}

/** 组（带数量的环）：「香港 · 深圳 · 5 台」 */
export function groupTipText(label: string, count: number): string {
  return `${label} · ${count} 台`;
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
  /** 先试上面还是下面（默认下面） */
  preferUp?: boolean;
  /** 上下都摆不下时还能摆到圆盘左右两侧：名字离锚点的水平距离（圆盘 / 组的环半宽 + 一点缝）；不传就不试 */
  sideGap?: number;
  /**
   * 名字下面那行（延迟 / 离线）去掉之后只剩一行的尺寸：两行怎么摆都压着别人时再按一行试一遍 ——
   * 城市名比延迟要紧，延迟点开就有。不传就不试
   */
  short?: { w: number; h: number; tightW: number };
};

/**
 * side：摆在了圆盘右边 / 左边（垂直居中），这时 dx 是名字左边缘相对锚点的偏移；否则 dx 是名字中线的左右挪动
 */
export type LabelPlacement = { key: string; up: boolean; dx: number; tight: boolean; box: PixelBox; side?: "left" | "right"; short?: boolean };

// 左右挪最多 22px：再远名字就不像是这个圆盘的了
const LABEL_SHIFTS = [0, -4, 4, -8, 8, -14, 14, -22, 22];

/**
 * 主机名的摆法：默认在圆盘下面；会压到别的名字、圆盘、⊗ 或露出卡片边时依次试：
 * 翻到另一侧 → 左右挪最多 22px → 缩小一号字 → 摆到圆盘右边 / 左边（给了 sideGap 时）。从上到下
 * 贪心放，先放的名字成为后面的障碍。挑不出一个完全干净的位置时选压得最少的（宁可露出边也不
 * 压别人）—— 精确框住时靠这个把图缩一点补回来。
 */
export function placeLabelBoxes(items: readonly LabelItem[], obstacles: readonly PixelBox[], area: PixelBox): LabelPlacement[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const placedBoxes: PixelBox[] = [];
  const result: LabelPlacement[] = [];
  /** 按一套尺寸（两行 / 只剩城市一行）把所有位置试一遍，返回压得最少的那个 */
  const search = (item: LabelItem): { best: LabelPlacement | null; bestScore: number } => {
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
          // 压到别人比露出边糟得多：露出边的话精确框住（settleFit）下一轮会把图缩一点补回来，压到别人就没救了
          let score = boxOutsideArea(box, area);
          for (const other of obstacles) score += boxOverlapArea(box, other) * 10;
          for (const other of placedBoxes) score += boxOverlapArea(box, other) * 10;
          // 完全干净就要它；否则记着最好的，缩小字号只在没有干净位置时才用
          if (score < bestScore - 1e-9) { bestScore = score; best = { key: item.key, up, dx, tight, box }; }
          if (score === 0) break;
        }
        if (bestScore === 0) break;
      }
      if (bestScore === 0) break;
    }
    // 上下怎么挪都压着别人（两台上下挨着）：摆到圆盘旁边，离卡片边远的那侧先试
    if (bestScore > 0 && item.sideGap !== undefined) {
      const center = area.x + area.w / 2;
      const order: Array<"left" | "right"> = item.x > center ? ["left", "right"] : ["right", "left"];
      for (const tight of [false, true]) {
        const w = tight ? item.tightW : item.w;
        for (const side of order) {
          const box: PixelBox = { x: side === "right" ? item.x + item.sideGap : item.x - item.sideGap - w, y: item.y - item.h / 2, w, h: item.h };
          let score = boxOutsideArea(box, area);
          for (const other of obstacles) score += boxOverlapArea(box, other) * 10;
          for (const other of placedBoxes) score += boxOverlapArea(box, other) * 10;
          if (score < bestScore - 1e-9) { bestScore = score; best = { key: item.key, up: false, dx: box.x - item.x, tight, box, side }; }
          if (score === 0) break;
        }
        if (bestScore === 0) break;
      }
    }
    return { best, bestScore };
  };
  for (const item of sorted) {
    let { best, bestScore } = search(item);
    // 两行（城市 + 延迟）怎么摆都压着别人：去掉延迟那行再试，城市名留得住就行
    if (bestScore > 0 && item.short) {
      const short = search({ ...item, w: item.short.w, h: item.short.h, tightW: item.short.tightW });
      if (short.best && short.bestScore < bestScore - 1e-9) { best = { ...short.best, short: true }; bestScore = short.bestScore; }
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

/**
 * 画真地图还是留着原来的 SVG 示意图：没有 WebGL（远程桌面、老浏览器）或者一台主机都
 * 没定位时，真地图上什么都摆不出来，示意图反而能把「谁连着谁」说清楚。
 */
export function shouldRenderRealMap(input: { webgl: boolean; locatedHosts: number }): boolean {
  return input.webgl && input.locatedHosts > 0;
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
