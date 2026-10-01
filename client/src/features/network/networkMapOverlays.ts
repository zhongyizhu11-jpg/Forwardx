import { fitViewToBoxes, type FitItem, type PixelBox, type PixelPoint } from "@shared/networkMapGeometry";

import { sheetSnapY, type MapPadding, type SheetSnap } from "./networkMapPageState";

/**
 * 整页地图上「浮着的东西」和地图留白、精确框住之间的数学。
 *
 * 整页地图上浮着标题、统计、工具栏、图例、底部抽屉（桌面是右边的详情卡），它们的尺寸随屏幕宽度、
 * 图例展开没有、抽屉在哪一档变来变去。以前留白是按桌面量好写死的几个数，到了手机上全不对：
 * 框住全部时主机被挤到左边缘切掉半个环、落地目标压在工具栏底下。
 *
 * 现在页面量出每一块的真实盒子（ResizeObserver），这里把它们换算成一块「不被任何东西盖住」的
 * 矩形（paddingForOverlays），作为 MapLibre 的留白；精确框住（settlePaddedFit）在同一块矩形里
 * 按每个 marker 真正占的像素（环 + 名字）框，谁都不会出界、也不会压在控件底下。
 *
 * 纯函数，不碰 DOM：node 里能直接用用户的拓扑和手机上的控件盒子测。
 */

/** 留白矩形离每块浮层再空出这么多（环的光、名字的晕不贴着玻璃卡） */
export const OVERLAY_GAP_PX = 8;
/** 精确框住时 marker 离留白矩形边至少这么远 */
export const PAGE_FIT_EDGE_PX = 10;
/** 留白矩形小到这样就不再自动框（抽屉拉到全屏时）：框进一条缝里只会缩成一张世界图 */
export const MIN_FIT_AREA_PX = 120;

export type ContainerSize = { width: number; height: number };

const area = (box: PixelBox) => Math.max(0, box.w) * Math.max(0, box.h);

function clip(box: PixelBox, bounds: PixelBox): PixelBox | null {
  const x = Math.max(box.x, bounds.x);
  const y = Math.max(box.y, bounds.y);
  const right = Math.min(box.x + box.w, bounds.x + bounds.w);
  const bottom = Math.min(box.y + box.h, bounds.y + bounds.h);
  if (right - x <= 0.5 || bottom - y <= 0.5) return null;
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * 从几块浮层算出一块不被盖住的矩形，换算成地图留白（离容器四边各多远）。
 *
 * MapLibre 的留白、精确框住都只认一个矩形，所以要在浮层之间找一块最大的空矩形。最大的空矩形
 * 四条边一定各贴着某块浮层的边或容器的边，所以把「容器边 + 每块浮层的对应边」当候选，四条边
 * 两两组合试一遍（浮层不过十来块，一万来个矩形），挑不压着任何浮层、面积最大的那个。
 * 手机上图例小条在左下、工具栏在右下：图例让出底下 40 来像素比让出左边 90 像素宽划算，
 * 工具栏一百多像素高、四十几像素宽，让出右边划算 —— 面积说了算，不用按控件写死归哪边。
 * 一块块贪心地归边不行：先处理的工具栏归了右边，后面的抽屉、图例就只剩更差的选择。
 */
export function paddingForOverlays(size: ContainerSize, boxes: readonly PixelBox[], gap = OVERLAY_GAP_PX): MapPadding {
  const bounds: PixelBox = { x: 0, y: 0, w: Math.max(0, size.width), h: Math.max(0, size.height) };
  const grown = boxes
    .map((box) => clip({ x: box.x - gap, y: box.y - gap, w: box.w + gap * 2, h: box.h + gap * 2 }, bounds))
    .filter((box): box is PixelBox => !!box);
  const uniq = (values: number[]) => Array.from(new Set(values.map((value) => Math.round(value * 10) / 10))).sort((a, b) => a - b);
  const tops = uniq([0, ...grown.map((box) => box.y + box.h)]);
  const bottoms = uniq([bounds.h, ...grown.map((box) => box.y)]);
  const lefts = uniq([0, ...grown.map((box) => box.x + box.w)]);
  const rights = uniq([bounds.w, ...grown.map((box) => box.x)]);
  let best: PixelBox = { x: 0, y: 0, w: 0, h: 0 };
  for (const top of tops) {
    for (const bottom of bottoms) {
      if (bottom <= top) continue;
      // 这一条横带里压着的浮层：左右边只能在它们之间找
      const band = grown.filter((box) => box.y < bottom && top < box.y + box.h);
      for (const left of lefts) {
        for (const right of rights) {
          if (right <= left) continue;
          const candidate = { x: left, y: top, w: right - left, h: bottom - top };
          if (area(candidate) <= area(best)) continue;
          if (band.some((box) => box.x < right && left < box.x + box.w)) continue;
          best = candidate;
        }
      }
    }
  }
  const round = (value: number) => Math.max(0, Math.round(value));
  return {
    top: round(best.y),
    left: round(best.x),
    right: round(size.width - best.x - best.w),
    bottom: round(size.height - best.y - best.h),
  };
}

/** 手机上底部抽屉在某一档时盖住的那块（抽屉是 transform 动画，量 DOM 会量到动画中间，所以按档位算） */
export function sheetOverlayBox(snap: SheetSnap, size: ContainerSize): PixelBox {
  const y = sheetSnapY(snap, size.height);
  return { x: 0, y, w: size.width, h: Math.max(0, size.height - y) };
}

/** 留白之后那块看得见、没被盖住的矩形 */
export function visibleArea(size: ContainerSize, padding: MapPadding): PixelBox {
  return {
    x: padding.left,
    y: padding.top,
    w: Math.max(0, size.width - padding.left - padding.right),
    h: Math.max(0, size.height - padding.top - padding.bottom),
  };
}

/** 留白之后剩的地方够不够自动框（抽屉拉到全屏时不够） */
export function canAutoFit(size: ContainerSize, padding: MapPadding): boolean {
  const rect = visibleArea(size, padding);
  return rect.w >= MIN_FIT_AREA_PX && rect.h >= MIN_FIT_AREA_PX;
}

export type PaddedFit = {
  zoomDelta: number;
  /** 现在屏幕上的这个点该成为新的地图中心（MapLibre 有留白时，中心画在留白矩形的正中，不是容器正中） */
  centerPx: PixelPoint;
  fits: boolean;
};

/**
 * 在留白矩形里框住这批 marker：fitViewToBoxes 算的是「哪个点挪到容器正中」，而地图设了留白之后
 * jumpTo 的 center 画在留白矩形的正中 pc。设新的缩放比例 k，fitViewToBoxes 给的变换是
 * p' = c0 + k(p − q)；MapLibre 的是 p' = pc + k(p − q')，两者相等要 q' = q + (pc − c0) / k。
 */
export function fitInPaddedArea(size: ContainerSize, items: readonly FitItem[], padding: MapPadding, options: { maxScale?: number; minScale?: number; edge?: number } = {}): PaddedFit | null {
  const edge = options.edge ?? PAGE_FIT_EDGE_PX;
  const inset = { top: padding.top + edge, right: padding.right + edge, bottom: padding.bottom + edge, left: padding.left + edge };
  const fit = fitViewToBoxes(size, items, inset, { maxScale: options.maxScale, minScale: options.minScale });
  if (!fit) return null;
  const c0 = { x: size.width / 2, y: size.height / 2 };
  const pc = paddedCenter(size, padding);
  return {
    zoomDelta: fit.zoomDelta,
    centerPx: { x: fit.centerPx.x + (pc.x - c0.x) / fit.scale, y: fit.centerPx.y + (pc.y - c0.y) / fit.scale },
    fits: fit.fits,
  };
}

/** 留白矩形的正中（MapLibre 把 center 画在这里） */
export function paddedCenter(size: ContainerSize, padding: MapPadding): PixelPoint {
  return {
    x: padding.left + (size.width - padding.left - padding.right) / 2,
    y: padding.top + (size.height - padding.top - padding.bottom) / 2,
  };
}

/**
 * 精确框住的收敛循环（整页画布和单元测试共用这一份）：量一次每个 marker 真正占的像素、跳一次，
 * 再量 —— 缩放变了簇会分合、名字会换边，几轮就收敛。头几轮允许往里放大到 maxZoom（空着的地方
 * 别浪费），之后只缩不放，量到不用再缩放、也不用再挪才停。
 */
export function settlePaddedFit(input: {
  size: ContainerSize;
  padding: MapPadding;
  /** 按当前视角重新布局并量出每个 marker 占的像素 */
  measure: () => FitItem[];
  zoom: () => number;
  /** 把屏幕上的 centerPx 设成新中心、缩放到 zoom（跳，不飞） */
  jump: (centerPx: PixelPoint, zoom: number) => void;
  maxZoom: number;
  minZoom: number;
  zoomInRounds?: number;
  rounds?: number;
  edge?: number;
}): { rounds: number; fits: boolean } {
  const { size, padding, measure, zoom, jump, maxZoom, minZoom } = input;
  const zoomInRounds = input.zoomInRounds ?? 2;
  const rounds = input.rounds ?? 8;
  const pc = paddedCenter(size, padding);
  let fits = true;
  let round = 0;
  for (; round < rounds; round += 1) {
    const items = measure();
    const current = zoom();
    const top = round < zoomInRounds ? maxZoom : Math.min(current, maxZoom);
    const fit = fitInPaddedArea(size, items, padding, { maxScale: 2 ** (top - current), minScale: 2 ** (Math.min(minZoom, top) - current), edge: input.edge });
    if (!fit) break;
    fits = fit.fits;
    if (Math.abs(fit.zoomDelta) < 0.004 && Math.hypot(fit.centerPx.x - pc.x, fit.centerPx.y - pc.y) < 0.75) break;
    jump(fit.centerPx, current + fit.zoomDelta);
  }
  return { rounds: round, fits };
}
