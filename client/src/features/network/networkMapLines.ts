import { describeFailoverActiveLine } from "@shared/failoverActiveLine";
import { describeNetworkHealth, type NetworkHealth } from "@shared/networkHealth";
import { ROUTE_MODE_INFO, ROUTE_SWITCH_MODE_INFO, routeGroupOf, routePathDestination, routePathLabel } from "@shared/routeGroup";

import type { NetworkMapModel, NetworkMapRuleRouteGroup } from "./networkMapModel";

/**
 * 地图上的线分四类，图例上正好四条：
 *
 *   主线路   正在用、探测通过的线（实线亮蓝，上面有流动的光点）
 *   备用线路 没在用的线：手动停用 / 待命的隧道，以及线路组里没轮到的那几条路径（白灰虚线）
 *   降级线路 在用、但探测说不太好（橙色虚线）
 *   中断线路 该通没通（红色虚线，正中一个 ⊗）
 *
 * 隧道没有「主 / 备」这个字段，只有状态 —— 所以隧道按状态归类：正常 = 主线路、停用 = 备用。
 * 「未上报」（还没探出结论）既不能当正常画成实线，也不是故障，画法和备用一样（灰虚线）、计数也算在
 * 备用里：图例只有四条，这是最不误导的一档。真正的「主 / 备」只有线路组（规则上的 routePaths）有：
 * 正在走的那条是主线路，没轮到的是备用线路（buildRouteLines）。
 *
 * 纯函数，在 node 里测。
 */
export type LineKind = "main" | "backup" | "degraded" | "down";

export const LINE_KINDS: LineKind[] = ["main", "backup", "degraded", "down"];

export const LINE_KIND_LABELS: Record<LineKind, string> = {
  main: "主线路",
  backup: "备用线路",
  degraded: "降级线路",
  down: "中断线路",
};

/** 图例、筛选上的短名 */
export const LINE_KIND_SHORT: Record<LineKind, string> = {
  main: "主线路",
  backup: "备用",
  degraded: "降级",
  down: "中断",
};

export function lineKindOfHealth(health: NetworkHealth): LineKind {
  const token = describeNetworkHealth(health).token;
  if (token === "healthy") return "main";
  // 切换中（path）也是「在用但不稳」，画成降级
  if (token === "warn" || token === "path") return "degraded";
  if (token === "down") return "down";
  return "backup";
}

/**
 * 线路组的一条路径画成的线：从调度所在的那台机出发，依次经过中转。
 * 调度在哪台机上：直连的规则是规则所在的入口机；挂在隧道上的规则是隧道出口机（shared/routeGroup：
 * 能挂线路组的隧道，调度器都在出口）。
 */
export type NetworkMapRouteLine = {
  /** `r:<规则 id>:<路径 key>` */
  key: string;
  ruleId: number;
  ruleName: string;
  tunnelId: number | null;
  index: number;
  /** 「主线路」「晚高峰线路」 */
  name: string;
  hosts: number[];
  active: boolean;
  kind: LineKind;
};

type RouteRuleInput = {
  id: number;
  name: string;
  hostId: number;
  tunnelId: number | null;
  health: NetworkHealth;
  routeGroup: NetworkMapRuleRouteGroup | null;
};

/**
 * 线路组 → 地图上的线。只画至少经过一台中转的路径（直连落地的路径在主机之间没有线可画；落地那一段
 * 由「落地流向」画），所有主机都得在这个账号看得到的主机里。
 *
 * 正在走哪条：Agent 报上来的那条（failoverActiveTarget）；还没报过时按配置的第一条（主线路）算 ——
 * 这只决定哪条画成实线，抽屉里「最近切换」照实写「—」，不冒充上报。
 */
export function buildRouteLines(rules: readonly RouteRuleInput[], options: { visibleHostIds: ReadonlySet<number>; tunnelExit: (tunnelId: number) => number | null }): NetworkMapRouteLine[] {
  const lines: NetworkMapRouteLine[] = [];
  for (const rule of rules) {
    const group = rule.routeGroup;
    if (!group) continue;
    const origin = rule.tunnelId ? options.tunnelExit(rule.tunnelId) : rule.hostId;
    if (!origin) continue;
    const activeIndex = group.activeIndex ?? 0;
    group.paths.forEach((path, index) => {
      if (path.hops.length === 0) return;
      const hosts = [origin, ...path.hops];
      if (!hosts.every((id) => options.visibleHostIds.has(id))) return;
      const active = index === activeIndex;
      let kind: LineKind;
      if (path.issue) kind = "down";
      else if (!active) kind = "backup";
      else kind = rule.health === "healthy" ? "main" : rule.health === "down" ? "down" : "backup";
      lines.push({ key: `r:${rule.id}:${path.key}`, ruleId: rule.id, ruleName: rule.name, tunnelId: rule.tunnelId, index, name: path.name, hosts, active, kind });
    });
  }
  return lines;
}

/** 规则上的线路组读成抽屉和地图要的样子；没开线路组是 null */
export function readRuleRouteGroup(rule: any, nowMs = Date.now()): NetworkMapRuleRouteGroup | null {
  const group = routeGroupOf(rule, { nowMs });
  if (!group) return null;
  const active = describeFailoverActiveLine(rule);
  return {
    mode: group.policy.mode,
    modeLabel: ROUTE_MODE_INFO[group.policy.mode].label,
    switchLabel: ROUTE_SWITCH_MODE_INFO[group.policy.switchMode].label,
    failoverSeconds: group.policy.failoverSeconds,
    recoverSeconds: group.policy.recoverSeconds,
    autoFailback: group.policy.autoFailback,
    paths: group.paths.map((path, index) => {
      const dest = routePathDestination(path, rule);
      return { key: path.key, name: routePathLabel(path, index), hops: [...path.hops], dest: dest.ip ? `${dest.ip}:${dest.port}` : null, issue: path.issue };
    }),
    activeIndex: active && active.index >= 0 ? active.index : null,
    activeSince: active?.since ? active.since * 1000 : null,
  };
}

/** 图例上的四个数：隧道（画得出、画不出的都算）+ 线路组的路径 */
export function lineLegend(model: Pick<NetworkMapModel, "links" | "stubs" | "routes">): Record<LineKind, number> {
  const counts: Record<LineKind, number> = { main: 0, backup: 0, degraded: 0, down: 0 };
  for (const link of model.links) counts[link.kind] += 1;
  for (const stub of model.stubs) counts[lineKindOfHealth(stub.health)] += 1;
  for (const route of model.routes) counts[route.kind] += 1;
  return counts;
}

/** 「N 链路线路」：所有隧道（含画不出来的）+ 线路组里画成线的路径 */
export function lineTotal(model: Pick<NetworkMapModel, "linkTotal" | "routes">): number {
  return model.linkTotal + model.routes.length;
}

/**
 * 整体可用率：此刻能用的隧道占该能用的隧道的比例（%）。
 *
 * 能用 = 正常或降级（降级的线还在通，linkAvailability 也把它算作 available）；不该算进来的：手动停用
 * （按设计就没在跑）和还没探出结论的（未上报）—— 拿没有结论的去拉低或抬高可用率都是编数。
 * linkAvailability 只给此刻的状态，没有 24 小时的可用率，所以这是「此刻」的比例；一条该能用的都没有
 * 时返回 null（页面写「—」）。
 */
export function overallAvailability(model: Pick<NetworkMapModel, "links" | "stubs">): number | null {
  let usable = 0;
  let eligible = 0;
  for (const health of [...model.links.map((link) => link.health), ...model.stubs.map((stub) => stub.health)]) {
    if (health === "standby" || health === "unknown") continue;
    eligible += 1;
    if (health === "healthy" || health === "degraded") usable += 1;
  }
  return eligible > 0 ? (usable / eligible) * 100 : null;
}

export function formatAvailability(value: number | null): string {
  if (value === null) return "—";
  if (value >= 99.95) return "100%";
  return `${value.toFixed(1)}%`;
}

/**
 * 「枢纽」：画成亮蓝、光晕大一圈的那台。选中了主机就是它；没选时是挂着最多条线（至少两条）的那台在线
 * 主机（一样多取 id 小的）—— 一眼看出流量汇在哪。掉线的不当枢纽：它该是红的。
 */
export function pickHubNode(model: Pick<NetworkMapModel, "nodes">, selectedHostId: number | null = null): number | null {
  if (selectedHostId && model.nodes.some((node) => node.id === selectedHostId)) return selectedHostId;
  let best: { id: number; count: number } | null = null;
  for (const node of model.nodes) {
    if (node.health !== "healthy" || node.linkCount < 2) continue;
    if (!best || node.linkCount > best.count || (node.linkCount === best.count && node.id < best.id)) best = { id: node.id, count: node.linkCount };
  }
  return best?.id ?? null;
}

export type NodeTone = "hub" | "ok" | "warn" | "down" | "standby";

/**
 * 主机画成什么颜色：掉线红、没接入过灰；在线的看经过它的线 —— 有线、且一条能用的主线路都没有
 * （全是降级 / 中断）就是琥珀色，不然绿；枢纽亮蓝。
 */
export function nodeTone(model: Pick<NetworkMapModel, "nodes" | "links">, hostId: number, hubId: number | null): NodeTone {
  const node = model.nodes.find((item) => item.id === hostId);
  if (!node) return "standby";
  if (node.health === "down") return "down";
  if (node.health !== "healthy") return "standby";
  if (hubId === hostId) return "hub";
  const through = model.links.filter((link) => link.path.includes(hostId) && link.kind !== "backup");
  if (through.length > 0 && through.every((link) => link.kind === "degraded" || link.kind === "down")) return "warn";
  return "ok";
}

/**
 * 主机名下面那行延迟：流量到这台机要多久（ms）。走过它的每条隧道里，它不是入口的那些：逐跳延迟齐全时
 * 用从入口累加到它的那段，它是出口时用整条隧道的延迟；取最小的那个。入口机、没有延迟数据的返回 null
 * （不写这一行，不编一个数）。
 */
export function nodeLatency(model: Pick<NetworkMapModel, "links">, hostId: number): number | null {
  let best: number | null = null;
  for (const link of model.links) {
    const index = link.path.indexOf(hostId);
    if (index <= 0) continue;
    let value: number | null = null;
    const hops = link.hopLatencies.slice(0, index);
    if (hops.length === index && hops.every((hop) => typeof hop === "number")) value = (hops as number[]).reduce((sum, hop) => sum + hop, 0);
    else if (index === link.path.length - 1 && typeof link.latencyMs === "number") value = link.latencyMs;
    if (value !== null && (best === null || value < best)) best = value;
  }
  return best;
}

/**
 * 主备线路对比：选中一条隧道时，和它比的备用是哪些。
 *   · 同一入口、同一出口、但没在用（备用类）的别的隧道
 *   · 挂在这条隧道上的规则的线路组里，没轮到的路径
 * 拿不到的就是空的 —— 抽屉和图上不编备用。
 */
export function backupsForTunnel(model: Pick<NetworkMapModel, "links" | "routes">, tunnelId: number): { tunnels: number[]; routes: string[] } {
  const link = model.links.find((item) => item.id === tunnelId);
  if (!link) return { tunnels: [], routes: [] };
  const entry = link.path[0];
  const exit = link.path[link.path.length - 1];
  const tunnels = model.links
    .filter((other) => other.id !== tunnelId && other.kind === "backup" && other.path[0] === entry && other.path[other.path.length - 1] === exit)
    .map((other) => other.id);
  const routes = model.routes.filter((route) => route.tunnelId === tunnelId && !route.active).map((route) => route.key);
  return { tunnels, routes };
}

/** 图上的筛选：全部 / 只看某一类线 */
export type LineFilter = "all" | LineKind;

export const LINE_FILTER_OPTIONS: Array<{ id: LineFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "main", label: "正常" },
  { id: "degraded", label: "降级" },
  { id: "down", label: "中断" },
  { id: "backup", label: "备用" },
];

export function lineVisible(kind: LineKind, filter: LineFilter): boolean {
  return filter === "all" || filter === kind;
}

/** 筛选之后图上还剩哪些主机（挂着一条看得见的线的）；全部时返回 null（都画） */
export function hostsForFilter(model: Pick<NetworkMapModel, "links" | "routes">, filter: LineFilter): Set<number> | null {
  if (filter === "all") return null;
  const hosts = new Set<number>();
  for (const link of model.links) if (lineVisible(link.kind, filter)) for (const id of link.path) hosts.add(id);
  for (const route of model.routes) if (lineVisible(route.kind, filter)) for (const id of route.hosts) hosts.add(id);
  return hosts;
}
