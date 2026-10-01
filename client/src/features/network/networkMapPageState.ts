import { backupsForTunnel } from "./networkMapLines";
import type { NetworkMapModel } from "./networkMapModel";

/**
 * 网络地图整页的状态数学：抽屉三档、地图留白、聚焦集合。
 *
 * 纯函数，不碰 DOM —— 拖把手松开落到哪一档、抽屉升起时地图该让出多少，
 * 这些数在 node 里能直接测，页面组件只负责把手势和尺寸喂进来。
 */

export type SheetSnap = "peek" | "half" | "full";

/** 收起时露出的高度：一行「N 台主机 · N 条线路」加把手 */
export const SHEET_PEEK_HEIGHT = 84;
/** 半屏露出 48%、全屏露出 90% */
export const SHEET_HALF_RATIO = 0.48;
export const SHEET_FULL_RATIO = 0.9;
/** 抽屉变成右侧栏的宽度分界 */
export const RAIL_MIN_WIDTH = 900;
export const RAIL_WIDTH = 384;

const SNAP_ORDER: SheetSnap[] = ["full", "half", "peek"];

/** 某一档时抽屉顶边离容器顶部的距离（translateY 的值） */
export function sheetSnapY(snap: SheetSnap, containerHeight: number): number {
  const H = Math.max(0, containerHeight);
  if (snap === "peek") return Math.max(0, H - SHEET_PEEK_HEIGHT);
  if (snap === "half") return Math.round(H * (1 - SHEET_HALF_RATIO));
  return Math.round(H * (1 - SHEET_FULL_RATIO));
}

/** 拖动中把 y 夹在全屏和收起之间 */
export function clampSheetY(y: number, containerHeight: number): number {
  return Math.max(sheetSnapY("full", containerHeight), Math.min(sheetSnapY("peek", containerHeight), y));
}

/**
 * 松手后落到哪一档。
 *
 *   几乎没动（< 6px）   收起的点一下升到半屏，其他档不变
 *   快速下滑 / 上滑     往那个方向走一档（速度阈值 0.45 px/ms）
 *   慢慢拖              吸附到离松手位置最近的一档
 */
export function nextSheetSnap(input: {
  current: SheetSnap;
  startY: number;
  endY: number;
  /** 松手前最后一小段的速度，px/ms，向下为正 */
  velocity: number;
  containerHeight: number;
}): SheetSnap {
  const { current, startY, endY, velocity, containerHeight } = input;
  const index = SNAP_ORDER.indexOf(current);
  if (Math.abs(endY - startY) < 6) return current === "peek" ? "half" : current;
  if (velocity > 0.45) return SNAP_ORDER[Math.min(SNAP_ORDER.length - 1, index + 1)];
  if (velocity < -0.45) return SNAP_ORDER[Math.max(0, index - 1)];
  const y = clampSheetY(sheetSnapY(current, containerHeight) + (endY - startY), containerHeight);
  let best: SheetSnap = "peek";
  let bestDistance = Infinity;
  for (const snap of SNAP_ORDER) {
    const distance = Math.abs(sheetSnapY(snap, containerHeight) - y);
    if (distance < bestDistance) { bestDistance = distance; best = snap; }
  }
  return best;
}

export type MapPadding = { top: number; bottom: number; left: number; right: number };

/**
 * 地图的可视区留白：飞入、框住永远落在看得见的那块正中。
 *   桌面：顶上让出标题和一排统计卡，右边让出竖着的工具栏；右边的详情卡开着时再让出它的宽度，
 *         底下让出图例
 *   手机：顶上让出标题和横着滚的统计卡，右边让出工具栏，底下抽屉盖住多少让出多少
 */
export function mapPaddingForSheet(snap: SheetSnap, containerHeight: number, rail: boolean, panelOpen = false): MapPadding {
  if (rail) return { top: 150, bottom: 64, left: 40, right: panelOpen ? RAIL_WIDTH + 96 : 96 };
  const H = Math.max(0, containerHeight);
  const visible = snap === "peek" ? SHEET_PEEK_HEIGHT : snap === "half" ? H * SHEET_HALF_RATIO : H * 0.55;
  return { top: 150, bottom: Math.round(visible) + 12, left: 20, right: 64 };
}

export type MapFocus = {
  hosts: number[];
  tunnels: number[];
  targets: string[];
  rules: number[];
  /** 线路组里画成线的路径（key），不在里面的压暗；没给就全压暗 */
  routes?: string[];
  /** 主备线路对比：选中的这条隧道 + 它的备用（同入口同出口的备用隧道、线路组里没轮到的路径） */
  compare?: { tunnelId: number; backupTunnels: number[]; backupRoutes: string[] };
  /** 「退出聚焦」药丸上的字和颜色 */
  label: string;
  severity: "error" | "warning" | "info";
};

export type MapSheetView =
  | { view: "overview" }
  | { view: "node"; id: number }
  | { view: "link"; id: number }
  | { view: "target"; id: string };

/** 点开一台主机时聚焦它和经过它的线（不压暗遮罩，只是让相关的亮一点） */
export function focusForNode(model: NetworkMapModel, hostId: number): MapFocus | null {
  const node = model.nodes.find((item) => item.id === hostId);
  if (!node) return null;
  const tunnels = model.links.filter((link) => link.path.includes(hostId));
  const hosts = new Set<number>([hostId]);
  for (const link of tunnels) for (const id of link.path) hosts.add(id);
  const targets = model.targets.filter((target) => target.sourceHostIds.includes(hostId)).map((target) => target.key);
  return { hosts: Array.from(hosts), tunnels: tunnels.map((link) => link.id), targets, rules: [], label: node.name, severity: "info" };
}

/**
 * 点开一条隧道：主备线路对比 —— 它自己和它的备用（backupsForTunnel）亮着，别的全压暗。
 * 备用经过的主机也算在里面，不然虚线连着两个压暗的环，看不出是从哪到哪。
 */
export function focusForLink(model: NetworkMapModel, tunnelId: number): MapFocus | null {
  const link = model.links.find((item) => item.id === tunnelId);
  if (!link) return null;
  const rules = model.rules.filter((rule) => rule.tunnelId === tunnelId);
  const backups = backupsForTunnel(model, tunnelId);
  const hosts = new Set<number>(link.path);
  for (const id of backups.tunnels) for (const hostId of model.links.find((item) => item.id === id)?.path ?? []) hosts.add(hostId);
  for (const key of backups.routes) for (const hostId of model.routes.find((route) => route.key === key)?.hosts ?? []) hosts.add(hostId);
  return {
    hosts: Array.from(hosts),
    tunnels: [tunnelId, ...backups.tunnels],
    targets: Array.from(new Set(rules.map((rule) => rule.targetKey).filter(Boolean))),
    rules: rules.map((rule) => rule.id),
    routes: backups.routes,
    compare: { tunnelId, backupTunnels: backups.tunnels, backupRoutes: backups.routes },
    label: link.name,
    severity: "info",
  };
}

export function focusForTarget(model: NetworkMapModel, key: string): MapFocus | null {
  const target = model.targets.find((item) => item.key === key);
  if (!target) return null;
  const rules = model.rules.filter((rule) => rule.targetKey === key);
  const tunnels = Array.from(new Set(rules.map((rule) => rule.tunnelId).filter((id): id is number => id !== null)));
  const hosts = new Set<number>(target.sourceHostIds);
  for (const rule of rules) hosts.add(rule.hostId);
  return { hosts: Array.from(hosts), tunnels, targets: [key], rules: rules.map((rule) => rule.id), label: target.address, severity: "info" };
}

/** 一个主机 / 目标 / 线是否在聚焦集合外（要压暗） */
export function isHostDimmed(focus: MapFocus | null, hostId: number) {
  return !!focus && !focus.hosts.includes(hostId);
}
export function isTunnelDimmed(focus: MapFocus | null, tunnelId: number) {
  return !!focus && !focus.tunnels.includes(tunnelId);
}
/** 线路组的一条路径：聚焦时只有点名的那几条亮着 */
export function isRouteDimmed(focus: MapFocus | null, routeKey: string) {
  return !!focus && !(focus.routes ?? []).includes(routeKey);
}
export function isTargetDimmed(focus: MapFocus | null, key: string) {
  return !!focus && !focus.targets.includes(key);
}
export function isFlowDimmed(focus: MapFocus | null, targetKey: string, ruleIds: readonly number[]) {
  if (!focus) return false;
  if (focus.targets.includes(targetKey)) return false;
  return !ruleIds.some((id) => focus.rules.includes(id));
}

/** 簇里只要有一个成员在聚焦集合里，整个簇就不压暗 */
export function isClusterDimmed(focus: MapFocus | null, members: ReadonlyArray<{ kind: "host"; id: number } | { kind: "target"; key: string }>) {
  if (!focus) return false;
  return !members.some((member) => (member.kind === "host" ? focus.hosts.includes(member.id) : focus.targets.includes(member.key)));
}

/**
 * 首页小图点了一台主机 / 一条线，带着 `/map?host=3` 或 `/map?link=12` 过来：整页一打开就
 * 把那个详情弹出来。两个都带以主机为准；不是正整数就当没带。
 */
export function parseMapOpenQuery(search: string): { view: "node"; id: number } | { view: "link"; id: number } | null {
  let params: URLSearchParams;
  try { params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search); } catch { return null; }
  const host = Number(params.get("host"));
  if (Number.isInteger(host) && host > 0) return { view: "node", id: host };
  const link = Number(params.get("link"));
  if (Number.isInteger(link) && link > 0) return { view: "link", id: link };
  return null;
}

/** 页头那句「5 台主机 · 3 条线路 · 2 项需要关注」 */
export function overviewHeadline(model: Pick<NetworkMapModel, "nodes" | "linkTotal"> & { routes?: readonly unknown[] }, alertCount: number): { main: string; attention: string | null } {
  // 线路数和统计卡「链路线路」同一个数：隧道 + 线路组里画成线的路径
  const main = `${model.nodes.length} 台主机 · ${model.linkTotal + (model.routes?.length ?? 0)} 条线路`;
  return { main, attention: alertCount > 0 ? `${alertCount} 项需要关注` : null };
}
