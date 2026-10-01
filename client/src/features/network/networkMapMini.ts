import { describeNetworkHealth, type NetworkHealth } from "@shared/networkHealth";
import { boxOutsideArea, boxOverlapArea, boxesIntersect, leaderBetweenBoxes, unionBox, type MapLayoutOptions, type PixelBox, type PixelPoint } from "@shared/networkMapGeometry";

import type { NetworkMapModel } from "./networkMapModel";

/**
 * 首页那块「网络地图」小图的规则：什么时候画真地图、框哪些点、什么时候重新框、用户拖过之后
 * 小窗怎么跟、挨着的主机怎么并成一组、局部放大的小窗摆在哪、名字怎么躲开彼此、点一下提示
 * 什么字。
 *
 * 纯函数（detectWebGL 除外），画布和卡片各自只管照着做；在 node 里能测。
 */

/** 小图框住所有主机时最多放大到这一级：两台同城的机器不该缩成一张街道图 */
export const MINI_FIT_MAX_ZOOM = 9;
/**
 * 小图上一跳的两端在屏幕上至少隔这么远才挂延迟小牌子（整页是 90）：卡片就巴掌大，短的那几跳
 * 挂上牌子只会压着主机和名字，点线时的提示里照样有延迟。
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
 * 主图和小窗共用的并组规则：28px 内的并成一组，圆盘会压到 pill 上的那台也并进去。小窗里也这样
 * 并 —— 小窗要框的几台里有一台离得远（窗放不大），剩下几台在窗里还是叠着，就再并成一枚小 pill
 * 画在它们真正的组心上；以前是错开成一圈，名字转着圈互相压、还被窗边切掉。
 * flagOf：layout 点的 key → 这台的旗（pill 有几面旗就有多宽）。
 */
export function miniGroupLayoutOptions(flagOf: ReadonlyMap<string, string | null | undefined>): MapLayoutOptions {
  return {
    mode: "cluster",
    clusterRadius: MINI_GROUP_RADIUS_PX,
    absorb: (keys, offset) => shouldAbsorbIntoGroup(new Set(keys.map((key) => flagOf.get(key)).filter(Boolean)).size, keys.length + 1, offset),
  };
}

/** 一组主机的地名：去重后的城市，最多三个（叠起来的 marker 和小窗标题都这么写） */
export function groupPlaceLabel(cities: readonly string[]): string {
  const unique: string[] = [];
  for (const city of cities) if (city && !unique.includes(city)) unique.push(city);
  return unique.slice(0, 3).join(" · ");
}

/** 主图、小窗上 marker 离卡片边至少留这么多像素 */
export const MINI_FIT_INSET_PX = 10;
/**
 * 小窗里名字离窗边至少留这么多像素：名字摆不进这个框、又不压别人时宁可藏起来（点圆盘的提示里
 * 还有名字），不画成一截被窗边切掉的字。
 */
export const INSET_LABEL_MARGIN_PX = 8;
/** 小窗精确框住时最多在 fitBounds 的基础上再缩这么多级：圈和名字实在放不下也别缩成一张世界图 */
export const INSET_MAX_ZOOM_OUT = 1.5;

// ---- 局部放大的小窗 ----

/** 主图上并成一组的主机：组员的真实位置、叠起来的 marker（含名字）占的盒子 */
export type MiniLayoutGroup = { hostIds: number[]; label: string; members: PixelPoint[]; markerBox: PixelBox };
/**
 * 主图每次布局完报给卡片的东西：卡片据此挑组开小窗、找空地摆小窗。
 * settled：这次是框好之后（首次、卡片变宽、主机集合变了、回到全览）报的 —— 卡片这时才重新
 * 摆小窗；用户拖图、缩放时报的是 false，卡片只挪圈和引线，小窗钉在原地。
 * userMoved：用户拖过 / 缩过、还没回到全览 —— 卡片据此显示「回到全览」。
 */
/** 小窗框好之后报给卡片的：窗多大（卡片据此认出这是哪个尺寸下的结果）、藏了几个要框的名字 */
export type InsetLayoutReport = { width: number; height: number; hiddenLabels: number };

/**
 * 手机上小窗要不要放大一号，一扇窗一个小状态机（窗的组员 / 卡片尺寸变了就从头来）：
 *   没试过（undefined）+ 标准尺寸下藏了名字 → try（卡片按 52% × 62% 重摆）；
 *   try + 放大后的报告：名字都摆下了 → keep，还是有藏的 → no（缩回标准尺寸，别白占主图）。
 * 每一步只认对应尺寸的报告：没试过时只认标准尺寸的，try 时只认放大尺寸的 —— 小窗刚建出来会连着
 * 框两次（首次 + ResizeObserver 的第一下），第二份标准尺寸的报告要是被当成「放大后的结果」，
 * 还没放大就判了 no。放大被主图的 marker 挡住（placeInsets 不放大）就一直停在 try，窗保持标准尺寸。
 * 桌面不放大。
 */
export type InsetGrowStage = "try" | "keep" | "no";
export function nextInsetGrowStage(
  stage: InsetGrowStage | undefined,
  report: InsetLayoutReport,
  sizes: { normal: InsetSize; large: InsetSize },
  desktop: boolean,
): InsetGrowStage | undefined {
  if (desktop) return stage;
  // 窗有 1px 的边框，画布比窗小 2px；标准和放大两档差着十几像素，差 3px 以内算同一档
  const matches = (size: InsetSize) => Math.abs(report.width - size.w) <= 3 && Math.abs(report.height - size.h) <= 3;
  if (stage === undefined) return matches(sizes.normal) && report.hiddenLabels > 0 ? "try" : undefined;
  if (stage === "try" && matches(sizes.large)) return report.hiddenLabels === 0 ? "keep" : "no";
  return stage;
}

export type MiniLayoutReport ={ width: number; height: number; groups: MiniLayoutGroup[]; boxes: PixelBox[]; points: PixelPoint[]; reserved: PixelBox[]; settled: boolean; userMoved: boolean };

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

/**
 * 钉住的小窗对应现在主图上的哪一组：组员一个不少的那组（缩小之后并进了更多台也算）。
 * 用户放大到组员在屏幕上分开了（组散了）就是 null，卡片藏起小窗和圈，缩回去又出现。
 */
export function matchInsetGroup<T extends { hostIds: number[] }>(hostIds: readonly number[], groups: readonly T[]): T | null {
  if (hostIds.length === 0) return null;
  return groups.find((group) => hostIds.every((id) => group.hostIds.includes(id))) ?? null;
}

/** 圈到小窗的引线：圈整个滚出图外就不拉（小窗还在，引线指向图外像画坏了） */
export function insetLeader(coverage: PixelBox | null, panel: PixelBox, container: { width: number; height: number }): [PixelPoint, PixelPoint] | null {
  if (!coverage) return null;
  if (!boxesIntersect(coverage, { x: 0, y: 0, w: container.width, h: container.height })) return null;
  return leaderBetweenBoxes(coverage, panel);
}

// ---- 点一下的提示（不跳整页，只说一句是谁）----

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

/** 组（叠起来的 marker）：「香港 · 深圳 · 5 台」 */
export function groupTipText(label: string, count: number): string {
  return `${label} · ${count} 台`;
}

export type Quadrant = "tl" | "tr" | "bl" | "br";
export type InsetSize = { w: number; h: number };
/** grown：手机上放大到了 52% × 62%（标准尺寸下有名字摆不下、放大后都摆得下时） */
export type InsetPlacement = { box: PixelBox; quadrant: Quadrant; shrunk: boolean; grown?: boolean };

/**
 * 小窗多大：手机上卡片宽的 46% × 高的 58%（五台一圈加上下的名字要 130px 高，48% 放不下），
 * 桌面 34% × 50%；挤不下时缩到最小。手机上标准尺寸里有名字摆不下时可以试着放大到
 * 52% × 62%（large）：只在放大后不压主图的 marker、而且名字真的都摆得下时才留着。
 */
export function insetSizes(container: { width: number; height: number }, desktop: boolean): { full: InsetSize; min: InsetSize; large: InsetSize } {
  const full = desktop
    ? { w: Math.round(container.width * 0.34), h: Math.round(container.height * 0.5) }
    : { w: Math.round(container.width * 0.46), h: Math.round(container.height * 0.58) };
  const min = desktop
    ? { w: Math.round(container.width * 0.24), h: Math.round(container.height * 0.38) }
    : { w: Math.round(container.width * 0.36), h: Math.round(container.height * 0.44) };
  // 桌面的小窗本来就够大，不放大
  const large = desktop ? full : { w: Math.round(container.width * 0.52), h: Math.round(container.height * 0.62) };
  return { full, min, large };
}

export type MiniOccupancy = {
  /** marker、名字、胶囊占的盒子 */
  boxes: readonly PixelBox[];
  /** 弧线采样点 */
  points: readonly PixelPoint[];
  /** 角上的小标签、+ / − 按钮：小窗绝不压上去，角被占了就往里挪一点（不传当没有） */
  reserved?: readonly PixelBox[];
};

const QUADRANTS: Quadrant[] = ["bl", "br", "tl", "tr"];
/** 标准尺寸放不下时，宽和高各在「标准 → 最小」之间分这么多档试 */
const INSET_SIZE_STEPS = 8;

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

/**
 * 小窗在某个角的盒子。角上有保留的东西（右下的 + / −、右上的「N 台未定位」）就往里挪到不压它为止：
 * 上下挪和左右挪挑挪得少的那个方向。
 */
export function cornerBox(container: { width: number; height: number }, quadrant: Quadrant, size: InsetSize, margin: number, reserved: readonly PixelBox[] = []): PixelBox {
  let box: PixelBox = {
    x: quadrant.endsWith("r") ? container.width - margin - size.w : margin,
    y: quadrant.startsWith("b") ? container.height - margin - size.h : margin,
    w: size.w,
    h: size.h,
  };
  for (const other of reserved) {
    if (!boxesIntersect(box, other)) continue;
    const dy = quadrant.startsWith("b") ? box.y + box.h - other.y : other.y + other.h - box.y;
    const dx = quadrant.endsWith("r") ? box.x + box.w - other.x : other.x + other.w - box.x;
    if (dy <= dx) box = { ...box, y: box.y + (quadrant.startsWith("b") ? -dy : dy) };
    else box = { ...box, x: box.x + (quadrant.endsWith("r") ? -dx : dx) };
  }
  return box;
}

/**
 * 小窗摆哪：象限按空的程度排（一样空时左下优先），先试标准尺寸；四个角都压到 marker 就在标准和
 * 最小之间找每个角放得下的最大尺寸，挑面积最大的；最小都放不下就挑压得最少的角。第二个小窗（桌面）
 * 还要躲开第一个。
 * grow[i]：第 i 个小窗想放大（卡片发现标准尺寸里有名字摆不下）—— 只在同一个角上试放大尺寸，
 * 压到主图的 marker、别的小窗就不放大（不换角：换了角引线和圈都要跳，用户看着像乱了）。
 */
export function placeInsets(
  container: { width: number; height: number },
  occupancy: MiniOccupancy,
  count: number,
  desktop: boolean,
  margin = MINI_FIT_INSET_PX,
  grow: readonly boolean[] = [],
): InsetPlacement[] {
  const placed: InsetPlacement[] = [];
  if (count <= 0 || container.width < 40 || container.height < 40) return placed;
  const scores = scoreQuadrants(container, occupancy);
  const order = [...QUADRANTS].sort((a, b) => scores[a] - scores[b] || QUADRANTS.indexOf(a) - QUADRANTS.indexOf(b));
  const sizes = insetSizes(container, desktop);
  const reserved = occupancy.reserved ?? [];
  for (let index = 0; index < count; index += 1) {
    const blocked = [...occupancy.boxes, ...placed.map((item) => item.box)];
    let choice: InsetPlacement | null = null;
    for (const quadrant of order) {
      const box = cornerBox(container, quadrant, sizes.full, margin, reserved);
      if (placed.some((item) => item.quadrant === quadrant)) continue;
      if (blocked.some((other) => boxesIntersect(box, other))) continue;
      choice = { box, quadrant, shrunk: false };
      break;
    }
    if (!choice) {
      // 标准尺寸哪个角都压到 marker：在标准和最小之间找每个角放得下的最大尺寸，挑面积最大的那个角
      // （一样大按空的程度）—— 手机卡片里悉尼的名字只占了右下角的一条边，没必要直接缩到最小
      let bestArea = 0;
      for (const quadrant of order) {
        if (placed.some((item) => item.quadrant === quadrant)) continue;
        for (let i = 0; i <= INSET_SIZE_STEPS; i += 1) {
          const w = Math.round(sizes.full.w - ((sizes.full.w - sizes.min.w) * i) / INSET_SIZE_STEPS);
          for (let j = 0; j <= INSET_SIZE_STEPS; j += 1) {
            const h = Math.round(sizes.full.h - ((sizes.full.h - sizes.min.h) * j) / INSET_SIZE_STEPS);
            if (w * h <= bestArea) continue;
            const box = cornerBox(container, quadrant, { w, h }, margin, reserved);
            if (blocked.some((other) => boxesIntersect(box, other))) continue;
            bestArea = w * h;
            choice = { box, quadrant, shrunk: true };
          }
        }
      }
    }
    if (!choice) {
      // 没有空角：最小尺寸放到压得最少的角
      let best: InsetPlacement | null = null;
      let bestArea = Infinity;
      for (const quadrant of order) {
        if (placed.some((item) => item.quadrant === quadrant)) continue;
        const box = cornerBox(container, quadrant, sizes.min, margin, reserved);
        const area = blocked.reduce((sum, other) => sum + boxOverlapArea(box, other), 0);
        if (area < bestArea) { bestArea = area; best = { box, quadrant, shrunk: true }; }
      }
      if (!best) break;
      choice = best;
    }
    if (grow[index] && !choice.shrunk && (sizes.large.w > choice.box.w || sizes.large.h > choice.box.h)) {
      const box = cornerBox(container, choice.quadrant, sizes.large, margin, reserved);
      const clear = !blocked.some((other) => boxesIntersect(box, other)) && !reserved.some((other) => boxesIntersect(box, other))
        && box.x >= 0 && box.y >= 0 && box.x + box.w <= container.width && box.y + box.h <= container.height;
      if (clear) choice = { box, quadrant: choice.quadrant, shrunk: false, grown: true };
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

/**
 * 小窗该框哪几台：主图上并成一组的不一定都挤在一块 —— pill 比圆盘宽，离得稍远的那台（港粤旁边的
 * 东京、台北）也会因为压到 pill 被并进来。小窗要框住它，就只能放到能同时看见两地的级别，真正叠在
 * 一起的港深莞几台在窗里还是一团。
 *
 * 所以：组员在主图上的外接范围比「真正压在一起的那一团」的范围大 4 倍以上时，小窗只框那一团
 * （圆心距离 < 28px 连起来的最大一簇；一样大挑更紧的），远的那台还算在主图 pill 的数里，只是不再
 * 要求出现在小窗里。那一团少于两台（组员两两都不压、只是被 pill 吸进来）就照旧框整组。
 * points 与 hostIds 一一对应（主图上的真实位置）。
 */
export function densestInsetMembers(group: { hostIds: readonly number[]; members: readonly PixelPoint[] }, radius = MINI_GROUP_RADIUS_PX): number[] {
  const ids = group.hostIds;
  const points = group.members;
  if (ids.length <= 2 || points.length !== ids.length) return [...ids];
  const extentOf = (indexes: readonly number[]) => {
    const xs = indexes.map((i) => points[i].x);
    const ys = indexes.map((i) => points[i].y);
    return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  };
  const whole = extentOf(ids.map((_, index) => index));
  // 连通半径从 28px 往下收：远的那台恰好离某个组员 27px（主图的缩放差一点）时，28px 会把它连进来，
  // 小窗就又得框到能看见台北的级别；收到 20、14 还能把真正叠在一起的那团分出来
  for (const r of [radius, radius * 0.7, radius * 0.5]) {
    // 连通分量：两台圆心距离 < r 就算压在一起
    const parent = ids.map((_, index) => index);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        if (Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) < r) parent[find(i)] = find(j);
      }
    }
    const clusters = new Map<number, number[]>();
    for (let i = 0; i < points.length; i += 1) clusters.set(find(i), [...(clusters.get(find(i)) ?? []), i]);
    let best: number[] | null = null;
    for (const members of clusters.values()) {
      if (!best || members.length > best.length || (members.length === best.length && extentOf(members) < extentOf(best))) best = members;
    }
    if (!best || best.length < 2) break;
    if (best.length === ids.length) continue;
    // 一团本身就有个几像素宽：别让 0 宽的一团（同一机房）把任何一点距离都放大成「远」
    if (whole <= 4 * Math.max(extentOf(best), 2)) continue;
    return best.map((i) => ids[i]).sort((a, b) => a - b);
  }
  return [...ids];
}

/**
 * 开哪几扇小窗、各框哪几台：每组先挑出真正挤在一起的那一团（densestInsetMembers），按这团的台数
 * 从多到少、一样多时更紧的在前，手机 1 扇、桌面 2 扇。group 原样带着（卡片拿它找圈、拉引线）。
 */
export function pickInsetSlots<T extends { hostIds: number[]; members: PixelPoint[] }>(groups: readonly T[], desktop: boolean): Array<{ group: T; hostIds: number[] }> {
  const extent = (points: readonly PixelPoint[]) => (points.length === 0 ? 0 : Math.max(
    Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x)),
    Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y)),
  ));
  return groups
    .filter((group) => group.hostIds.length >= 2)
    .map((group) => {
      const hostIds = densestInsetMembers(group);
      const points = hostIds.map((id) => group.members[group.hostIds.indexOf(id)]).filter(Boolean);
      return { group, hostIds, extent: extent(points) };
    })
    .sort((a, b) => b.hostIds.length - a.hostIds.length || a.extent - b.extent || a.hostIds[0] - b.hostIds[0])
    .slice(0, desktop ? 2 : 1)
    .map(({ group, hostIds }) => ({ group, hostIds }));
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
  /** 先放谁：小的先放（小窗里要框的那几台先挑位置，窗边路过的别的主机后放）；默认 0 */
  priority?: number;
  /** 上下都摆不下时还能摆到圆盘左右两侧：名字离锚点的水平距离（圆盘 / pill 半宽 + 一点缝）；不传就不试 */
  sideGap?: number;
};

/**
 * hidden：摆不出一个干净的位置（只在 hideUnplaceable 时出现）—— 名字不画，圆盘照画。
 * side：摆在了圆盘右边 / 左边（垂直居中），这时 dx 是名字左边缘相对锚点的偏移；否则 dx 是名字中线的左右挪动
 */
export type LabelPlacement = { key: string; up: boolean; dx: number; tight: boolean; box: PixelBox; hidden?: boolean; side?: "left" | "right" };

// 左右挪最多 22px：再远名字就不像是这个圆盘的了
const LABEL_SHIFTS = [0, -4, 4, -8, 8, -14, 14, -22, 22];

/**
 * 小图上主机名的摆法：默认在圆盘下面；会压到别的名字、圆盘、胶囊或露出卡片边时依次试：
 * 翻到另一侧 → 左右挪最多 22px → 缩小一号字 → 摆到圆盘右边 / 左边（给了 sideGap 时）。按 priority、
 * 再从上到下的顺序贪心放，先放的
 * 名字成为后面的障碍。挑不出一个完全干净的位置时：
 *   默认选压得最少的（宁可露出边也不压别人）—— 主图精确框住时靠这个把图缩一点补回来；
 *   hideUnplaceable 时直接藏起来（hidden）、也不当后面的障碍 —— 小窗框好之后用：窗不能拖，
 *   露出窗边的那截永远补不回来，压着别人更难看；点圆盘的提示里还有名字。
 */
export function placeLabelBoxes(items: readonly LabelItem[], obstacles: readonly PixelBox[], area: PixelBox, options: { hideUnplaceable?: boolean } = {}): LabelPlacement[] {
  const sorted = [...items].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.y - b.y || a.x - b.x);
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
    // 上下怎么挪都压着别人（两台上下挨着、中间还挂着胶囊）：摆到圆盘旁边，离窗边远的那侧先试
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
    if (!best) continue;
    // 亚像素的擦边看不出来，不算压
    if (options.hideUnplaceable && bestScore > 1) { result.push({ ...best, hidden: true }); continue; }
    placedBoxes.push(best.box);
    result.push(best);
  }
  return result;
}

/** 小窗试的一档缩放：画成了几枚 marker、藏了几个名字、要框的圆盘是不是都在窗里 */
export type InsetZoomCandidate = { zoom: number; markers: number; hidden: number; valid: boolean };

/**
 * 小窗挑哪一档缩放（返回下标，没有可用的是 -1）：圆盘都在窗里的档里，按「画出来几枚 marker − 0.6 × 藏掉
 * 几个名字」挑最高的，一样高挑放得更大的。
 * 为什么这么算：分开的圆盘本身就是这扇窗的意义，藏一个名字（4 枚藏 1 个：3.4）比为了它把两台并起来
 * （3 枚都有名字：3）好；可一个名字都没有的四枚（4 − 2.4 = 1.6）不如两枚名字都在的 pill（2）——
 * 藏掉的名字得一个个点才知道是谁。全并成一枚（1）永远最后。
 */
export function pickInsetZoom(candidates: readonly InsetZoomCandidate[]): number {
  let best = -1;
  let bestScore = -Infinity;
  candidates.forEach((candidate, index) => {
    if (!candidate.valid) return;
    const score = candidate.markers - candidate.hidden * 0.6;
    if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) < 1e-9 && best >= 0 && candidate.zoom > candidates[best].zoom)) { best = index; bestScore = score; }
  });
  if (best >= 0) return best;
  // 哪一档都有圆盘露出窗边（缩到底也放不下）：挑缩得最小的那档，至少别更糟
  return candidates.length > 0 ? candidates.reduce((low, candidate, index) => (candidate.zoom < candidates[low].zoom ? index : low), 0) : -1;
}

/** 小窗里名字能用的范围：窗本身四边各让出 8px */
export function insetLabelArea(size: { width: number; height: number }, margin = INSET_LABEL_MARGIN_PX): PixelBox {
  return { x: margin, y: margin, w: Math.max(0, size.width - margin * 2), h: Math.max(0, size.height - margin * 2) };
}

/**
 * 小窗框好之后的名字：以窗（让出 8px）为边界、标题条算障碍，和主图同一套摆法；摆不干净的藏起来。
 * 返回的每个 hidden 都是「这台的名字没画」，卡片据此决定要不要把窗放大一号再试。
 */
export function placeInsetLabels(items: readonly LabelItem[], obstacles: readonly PixelBox[], size: { width: number; height: number }): LabelPlacement[] {
  return placeLabelBoxes(items, obstacles, insetLabelArea(size), { hideUnplaceable: true });
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
