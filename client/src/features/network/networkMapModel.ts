import { useMemo } from "react";

import type { NetworkMapLink, NetworkMapNode } from "@/components/network/NetworkMap";
import { tunnelHealthFromAvailability } from "@/features/links/tunnelHealth";
import { hostGeoCoordinate } from "@/lib/hostGeo";
import { countryFlagLabel } from "@/lib/flagEmojiSupport";
import { resolveForwardRuleStopReason } from "@/lib/forwardRuleStatus";
import { pollingInterval } from "@/lib/polling";
import { getTunnelHopIds } from "@/lib/tunnelDisplay";
import { trpc } from "@/lib/trpc";
import { FORWARD_PROTOCOL_LABELS, TUNNEL_PROTOCOLS, normalizeForwardProtocolSettings } from "@shared/forwardTypes";
import { buildLinkAvailabilityIndex } from "@shared/linkAvailability";
import { formatAgo } from "@shared/dashboardAttention";
import { geoCountryNameZh, matchGeoCity } from "@shared/geoCities";
import { describeNetworkHealth, type NetworkHealth } from "@shared/networkHealth";
import type { RouteMode } from "@shared/routeGroup";

import { buildRouteLines, lineKindOfHealth, lineLegend, readRuleRouteGroup, type LineKind, type NetworkMapRouteLine } from "./networkMapLines";

/**
 * 网络地图的数据模型：首页那块「网络地图」和 /map 整页共用的一份。
 *
 * 数据用的是各页已经在用的两条轻量列表（hosts.options / tunnels.options），不新加接口。
 * 隧道的状态和隧道页一样从 linkAvailability 算 —— 这里红的，点进隧道页也是红的。
 *
 * 首页只用 nodes / links 画示意图；整页在这之上还要主机的 IP、版本、隧道的模式和
 * 异常原因、规则和落地目标 —— 所以节点和线是「示意图类型 + 细节字段」的超集，
 * 首页拿到多余的字段不用就是。
 */
function hostNote(host: any, now: number, linkCount: number): string | null {
  if (host?.isOnline === false || host?.isOnline === 0) {
    const seen = host?.lastHeartbeat ? new Date(host.lastHeartbeat).getTime() : NaN;
    return Number.isFinite(seen) && seen > 0 ? `离线 · ${formatAgo(now - seen)}` : "离线";
  }
  if (host?.lastHeartbeat == null && host?.isOnline !== true) return "还没接入";
  return linkCount > 0 ? `${linkCount} 条线路` : "在线";
}

/**
 * 图上写的城市名：IP 定位给的地区多半是英文（「Tokyo」「Central」），图上要中文 —— 先查随包的城市表
 * （shared/geoCities，中英文名都认）；查不到时，香港、澳门、新加坡这种一城一地的写地区名（「香港」），
 * 别的照原样。查不到也不猜。
 */
export function mapCityName(host: { geoCountryCode?: string | null; geoRegion?: string | null } | null | undefined): string | null {
  const matched = matchGeoCity(host);
  if (matched) return matched.name;
  const code = String(host?.geoCountryCode || "").trim().toUpperCase();
  if (code === "HK" || code === "MO" || code === "SG") return geoCountryNameZh(code).replace(/^中国/, "");
  return null;
}

function hostHealth(host: any): NetworkHealth {
  if (host?.isOnline === true || host?.isOnline === 1) return "healthy";
  if (host?.lastHeartbeat == null) return "unknown";
  return "down";
}

/** 隧道模式给人看的名字：forwardx → 「NEX V1」，gost 那些 → 「GOST TLS」。 */
export function tunnelModeLabel(tunnel: any): string {
  const mode = String(tunnel?.mode || "").toLowerCase();
  if (mode === "forwardx") {
    const version = String(tunnel?.forwardxVersion || "v1").toUpperCase();
    return `NEX ${version}`;
  }
  return (FORWARD_PROTOCOL_LABELS as Record<string, string>)[mode] || mode.toUpperCase() || "隧道";
}

export type NetworkMapHostNode = NetworkMapNode & {
  countryCode: string | null;
  /** 簇 pill 上的城市名：地区 → 国家 → 主机名 */
  city: string;
  /** 「香港 · Central」这种给人看的地区 */
  region: string | null;
  ip: string | null;
  isOnline: boolean;
  lastHeartbeat: number | null;
  agentVersion: string | null;
  fxpVersion: string | null;
  /** 内存总量（字节），节点抽屉的内存条要写「已用 / 总量」 */
  memoryTotal: number | null;
  linkCount: number;
};

export type NetworkMapTunnelLink = NetworkMapLink & {
  modeLabel: string;
  entryHostId: number | null;
  exitHostId: number | null;
  enabled: boolean;
  /** 可用性那句话（「最近一次独立探测可达（7ms）」） */
  availabilityMessage: string;
  availabilityStatus: string | null;
  /** FXP 握不上手的说明，每台一句 */
  fxpIssues: string[];
  /** 逐跳延迟（来自最近一次诊断），按 path 的段序；拿不到是空数组 */
  hopLatencies: Array<number | null>;
  lastTestAt: number | null;
  /** 地图上的四类线之一（networkMapLines：正常 = 主线路、停用 / 未上报 = 备用…） */
  kind: LineKind;
  createdAt: number | null;
};

/** 租户看不到一端的隧道：从看得见的那一端画一截灰线出去 */
export type NetworkMapStub = {
  tunnelId: number;
  name: string;
  hostId: number;
  health: NetworkHealth;
  modeLabel: string;
};

export type NetworkMapRule = {
  id: number;
  name: string;
  /** 入口主机 */
  hostId: number;
  tunnelId: number | null;
  /** 出口：走隧道的是隧道路径最后一台，直连的是入口自己 */
  exitHostId: number;
  sourcePort: number;
  targetIp: string;
  targetPort: number;
  /** 落地目标的键（小写地址） */
  targetKey: string;
  protocol: string;
  forwardType: string;
  enabled: boolean;
  running: boolean;
  health: NetworkHealth;
  /** 停着的原因（短标签），在跑就是 null */
  stopReason: string | null;
  protocolBlockReason: string | null;
  /** 开了线路组（主备）的规则：路径、策略、正在走哪条；没开是 null */
  routeGroup: NetworkMapRuleRouteGroup | null;
};

export type NetworkMapRuleRouteGroup = {
  mode: RouteMode;
  /** 「自动故障切换」 */
  modeLabel: string;
  /** 「平滑切换」 */
  switchLabel: string;
  failoverSeconds: number;
  recoverSeconds: number;
  autoFailback: boolean;
  paths: Array<{ key: string; name: string; hops: number[]; dest: string | null; issue: string | null }>;
  /** Agent 报上来正在走第几条；没报过是 null（不拿「默认走主线」去填） */
  activeIndex: number | null;
  /** 切到这条的时刻（毫秒）；没报过是 null */
  activeSince: number | null;
};

export type NetworkMapTarget = {
  key: string;
  address: string;
  geo: { lat: number; lng: number } | null;
  countryCode: string | null;
  city: string;
  emoji: string | null;
  ruleIds: number[];
  /** 从哪些主机拉线过来（规则的出口） */
  sourceHostIds: number[];
  health: NetworkHealth;
};

export type NetworkMapModel = {
  nodes: NetworkMapHostNode[];
  links: NetworkMapTunnelLink[];
  stubs: NetworkMapStub[];
  rules: NetworkMapRule[];
  targets: NetworkMapTarget[];
  /** 隧道总数，包括画不出来的那些 —— 页头「N 条线路」用这个数 */
  linkTotal: number;
  /** 两端里至少一端是这个账号看不到的主机的隧道数；它们存在、有状态，只是没法画成线 */
  hiddenLinkCount: number;
  legend: { healthy: number; degraded: number; down: number; standby: number };
  /** 线路组里画成线的路径（至少经过一台中转的） */
  routes: NetworkMapRouteLine[];
  /** 图例上四类线各几条（隧道 + 线路组路径） */
  lines: Record<LineKind, number>;
};

export type TargetGeoRow = { target: string; geo: any };

export function normalizeTargetKey(address: unknown) {
  return String(address || "").trim().toLowerCase();
}

/**
 * 逐跳延迟：从隧道最近一次诊断结果里按 fromHostId → toHostId 对上 path 的每一段。
 * 诊断结果是 JSON 文本（LinkTestLatencySummary.parseLinkTestMessage 那套），这里只认
 * 带 hostId 的明细；老格式、租户被抹掉的字段都对不上，就给空。
 */
export function tunnelHopLatencies(tunnel: any, path: number[]): Array<number | null> {
  const raw = typeof tunnel?.lastTestMessage === "string" ? tunnel.lastTestMessage.trim() : "";
  if (!raw || path.length < 2) return [];
  let details: any[] = [];
  try {
    const parsed = JSON.parse(raw);
    details = Array.isArray(parsed?.details) ? parsed.details : [];
  } catch {
    return [];
  }
  const bySegment = new Map<string, number | null>();
  for (const detail of details) {
    const from = Number(detail?.fromHostId || 0);
    const to = Number(detail?.toHostId || 0);
    if (from <= 0 || to <= 0) continue;
    bySegment.set(`${from}>${to}`, typeof detail?.latencyMs === "number" && Number.isFinite(detail.latencyMs) ? detail.latencyMs : null);
  }
  if (bySegment.size === 0) return [];
  return path.slice(1).map((to, index) => bySegment.get(`${path[index]}>${to}`) ?? null);
}

/**
 * 落地目标的定位：rules.targetGeoBatch 回的是 lookupAddressGeo 那一行（geoLatitudeMicro / geoLongitudeMicro /
 * geoCountryCode / geoRegion，和主机的定位字段同一套）。以前这里只认 latitude / longitude，服务端的行一个都
 * 对不上，落地目标从来没画到图上；两种写法都认（测试和老缓存用的是后一种）。
 */
export function readTargetGeo(geo: any): { geo: { lat: number; lng: number } | null; countryCode: string | null; city: string } {
  const micro = hostGeoCoordinate(geo);
  const lat = micro ? micro.lat : Number(geo?.latitude ?? geo?.lat);
  const lng = micro ? micro.lng : Number(geo?.longitude ?? geo?.lng);
  const valid = geo != null && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  return {
    geo: valid ? { lat, lng } : null,
    countryCode: String(geo?.geoCountryCode || geo?.countryCode || "").trim().toUpperCase() || null,
    city: String(geo?.geoRegion || geo?.region || geo?.city || geo?.geoCountryName || geo?.countryName || "").trim(),
  };
}

function ruleHealth(rule: any): NetworkHealth {
  if (rule?.resourceAccessAllowed === false) return "down";
  if (rule?.isEnabled === false || rule?.isEnabled === 0) return "standby";
  if (rule?.isRunning === false || rule?.isRunning === 0) return "unknown";
  return "healthy";
}

/**
 * 纯函数：把 hosts.options / tunnels.options（+ rules.list、落地目标定位）变成地图要画的点和线。
 *
 * 两条规则和隧道页保持一致，否则同一条隧道在首页和隧道页会是两种颜色：
 *
 * 一、协议开关。管理员在设置里停用了某个隧道协议时，隧道页把那条隧道标成红的
 *     （isTunnelSupported → down），这里也一样，所以 supported 要一路传进去。
 *
 * 二、看不见的主机。普通用户用共享隧道时，服务端会把不在他主机范围里的那一端
 *     抹掉（linkAccessView），但 availability 还在。这种隧道**不能当不存在**：
 *     它照样计入线路数和图例，只是画不成一条线（线要两个点）。看得见的那一端的
 *     「N 条线路」注脚也照样算上它；整页上从那一端画一截灰线（stubs）。
 */
export function buildNetworkMapModel(input: {
  hosts: any[];
  tunnels: any[];
  rules?: any[];
  targetGeo?: TargetGeoRow[];
  now?: number;
  isTunnelSupported?: (tunnel: any) => boolean;
}): NetworkMapModel {
  const { hosts, tunnels, isTunnelSupported } = input;
  const now = input.now ?? Date.now();
  const index = buildLinkAvailabilityIndex({ hosts, tunnels, now, isTunnelSupported });
  const hostIds = new Set(hosts.map((host) => Number(host?.id)));
  const linkCountByHost = new Map<number, number>();
  const links: NetworkMapTunnelLink[] = [];
  const stubs: NetworkMapStub[] = [];
  const legend = { healthy: 0, degraded: 0, down: 0, standby: 0 };
  let hiddenLinkCount = 0;
  for (const tunnel of tunnels) {
    const path: number[] = getTunnelHopIds(tunnel).map((id: unknown) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0);
    const state = index.tunnelAvailabilityById.get(Number(tunnel.id));
    const enabled = tunnel?.isEnabled !== false && tunnel?.isEnabled !== 0;
    const health = tunnelHealthFromAvailability(state?.status ?? tunnel?.availability?.status, {
      enabled,
      supported: isTunnelSupported ? isTunnelSupported(tunnel) !== false : undefined,
    });
    const token = describeNetworkHealth(health).token;
    if (token === "healthy") legend.healthy += 1;
    else if (token === "warn") legend.degraded += 1;
    else if (token === "down") legend.down += 1;
    else legend.standby += 1;
    for (const hostId of new Set(path)) linkCountByHost.set(hostId, (linkCountByHost.get(hostId) || 0) + 1);
    const modeLabel = tunnelModeLabel(tunnel);
    const name = String(tunnel.name || `隧道 #${tunnel.id}`);
    if (path.length < 2) {
      hiddenLinkCount += 1;
      const visibleEnd = path.find((id) => hostIds.has(id));
      if (visibleEnd) stubs.push({ tunnelId: Number(tunnel.id), name, hostId: visibleEnd, health, modeLabel });
      continue;
    }
    const lastTestAt = tunnel?.lastTestAt ? new Date(tunnel.lastTestAt).getTime() : NaN;
    const createdAt = tunnel?.createdAt ? new Date(tunnel.createdAt).getTime() : NaN;
    links.push({
      id: Number(tunnel.id),
      name,
      path,
      health,
      latencyMs: typeof tunnel?.lastLatencyMs === "number" ? tunnel.lastLatencyMs : null,
      modeLabel,
      entryHostId: Number(tunnel?.entryHostId) > 0 ? Number(tunnel.entryHostId) : null,
      exitHostId: Number(tunnel?.exitHostId) > 0 ? Number(tunnel.exitHostId) : null,
      enabled,
      availabilityMessage: String(state?.message ?? tunnel?.availability?.message ?? ""),
      availabilityStatus: state?.status ?? tunnel?.availability?.status ?? null,
      fxpIssues: (Array.isArray(tunnel?.fxpIssues) ? tunnel.fxpIssues : [])
        .map((issue: any) => String(issue?.message || "").trim())
        .filter(Boolean),
      hopLatencies: tunnelHopLatencies(tunnel, path),
      lastTestAt: Number.isFinite(lastTestAt) && lastTestAt > 0 ? lastTestAt : null,
      kind: lineKindOfHealth(health),
      createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : null,
    });
  }
  const nodes: NetworkMapHostNode[] = hosts.map((host) => {
    // 名字下面那行前面带上地区（「香港 · 2 条线路」）；国旗画在圆盘里
    const region = String(host?.geoRegion || host?.geoCountryName || "").trim();
    const linkCount = linkCountByHost.get(Number(host.id)) || 0;
    const note = hostNote(host, now, linkCount);
    const name = String(host.name || host.ip || host.ipv4 || `主机 #${host.id}`);
    const seen = host?.lastHeartbeat ? new Date(host.lastHeartbeat).getTime() : NaN;
    return {
      id: Number(host.id),
      name,
      health: hostHealth(host),
      note: [region, note].filter(Boolean).join(" · ") || null,
      geo: hostGeoCoordinate(host),
      // 这台设备画不出的旗（iOS 国行没有 🇹🇼）退回两字母代码，见 lib/flagEmojiSupport
      emoji: countryFlagLabel(host?.geoCountryCode) || null,
      countryCode: String(host?.geoCountryCode || "").trim().toUpperCase() || null,
      city: mapCityName(host) || region || name,
      region: region || null,
      ip: String(host?.ipv4 || host?.ip || "").trim() || null,
      isOnline: host?.isOnline === true || host?.isOnline === 1,
      lastHeartbeat: Number.isFinite(seen) && seen > 0 ? seen : null,
      agentVersion: host?.agentVersion ? String(host.agentVersion) : null,
      fxpVersion: host?.fxpVersion ? String(host.fxpVersion) : null,
      memoryTotal: Number(host?.memoryTotal) > 0 ? Number(host.memoryTotal) : null,
      linkCount,
    };
  });

  const linkById = new Map(links.map((link) => [link.id, link]));
  const rules: NetworkMapRule[] = (input.rules || []).map((rule) => {
    const hostId = Number(rule?.hostId || 0);
    const tunnelId = Number(rule?.tunnelId || 0) > 0 ? Number(rule.tunnelId) : null;
    const link = tunnelId ? linkById.get(tunnelId) : undefined;
    const exitHostId = link ? link.path[link.path.length - 1] : hostId;
    const stop = resolveForwardRuleStopReason(rule);
    return {
      id: Number(rule.id),
      name: String(rule?.name || `规则 #${rule?.id}`),
      hostId,
      tunnelId,
      exitHostId,
      sourcePort: Number(rule?.sourcePort || 0),
      targetIp: String(rule?.targetIp || "").trim(),
      targetPort: Number(rule?.targetPort || 0),
      targetKey: normalizeTargetKey(rule?.targetIp),
      protocol: String(rule?.protocol || "tcp"),
      forwardType: String(rule?.forwardType || ""),
      enabled: rule?.isEnabled !== false && rule?.isEnabled !== 0,
      running: rule?.isRunning === true || rule?.isRunning === 1,
      health: ruleHealth(rule),
      stopReason: stop?.label ?? null,
      protocolBlockReason: String(rule?.protocolBlockReason || "").trim() || null,
      routeGroup: readRuleRouteGroup(rule, now),
    };
  }).filter((rule) => rule.id > 0 && rule.hostId > 0);

  const geoByKey = new Map<string, any>();
  for (const row of input.targetGeo || []) {
    if (row?.target && row.geo) geoByKey.set(normalizeTargetKey(row.target), row.geo);
  }
  const targetMap = new Map<string, NetworkMapTarget>();
  for (const rule of rules) {
    if (!rule.targetKey) continue;
    let target = targetMap.get(rule.targetKey);
    if (!target) {
      const place = readTargetGeo(geoByKey.get(rule.targetKey));
      const countryCode = place.countryCode;
      const city = mapCityName({ geoCountryCode: place.countryCode, geoRegion: place.city }) || place.city || rule.targetIp;
      target = {
        key: rule.targetKey,
        address: rule.targetIp,
        geo: place.geo,
        countryCode,
        city,
        emoji: countryFlagLabel(countryCode) || null,
        ruleIds: [],
        sourceHostIds: [],
        health: "healthy",
      };
      targetMap.set(rule.targetKey, target);
    }
    target.ruleIds.push(rule.id);
    if (!target.sourceHostIds.includes(rule.exitHostId)) target.sourceHostIds.push(rule.exitHostId);
    // 目标的颜色取指向它的规则里最差的那条：一条挂了就该看见
    if (rule.health === "down") target.health = "down";
    else if (rule.health === "unknown" && target.health !== "down") target.health = "degraded";
  }

  const routes = buildRouteLines(rules, {
    visibleHostIds: new Set(nodes.filter((node) => node.geo).map((node) => node.id)),
    tunnelExit: (tunnelId) => { const link = linkById.get(tunnelId); return link ? link.path[link.path.length - 1] : null; },
  });
  return { nodes, links, stubs, rules, targets: Array.from(targetMap.values()), linkTotal: tunnels.length, hiddenLinkCount, legend, routes, lines: lineLegend({ links, stubs, routes }) };
}

export function useTunnelSupportCheck(enabled: boolean) {
  // 协议开关和隧道页读同一份设置；隧道页那边 staleTime 是 0，这里跟着不缓存。
  const settingsQuery = trpc.system.getSettings.useQuery(undefined, { enabled, staleTime: 0 });
  const forwardProtocols = (settingsQuery.data as any)?.forwardProtocols;
  return useMemo(() => {
    const protocolSettings = normalizeForwardProtocolSettings(forwardProtocols);
    return (tunnel: any) => {
      const key = String(tunnel?.mode || "").toLowerCase();
      return (TUNNEL_PROTOCOLS as readonly string[]).includes(key)
        && protocolSettings[key as keyof typeof protocolSettings] !== false;
    };
  }, [forwardProtocols]);
}

/** 首页那块用的：只有主机和隧道。 */
export function useNetworkMapModel(enabled: boolean) {
  const hostsQuery = trpc.hosts.options.useQuery(undefined, {
    enabled,
    refetchInterval: pollingInterval("normal"),
    staleTime: 5000,
    placeholderData: (previous) => previous,
  });
  const tunnelsQuery = trpc.tunnels.options.useQuery(undefined, {
    enabled,
    refetchInterval: pollingInterval("normal"),
    staleTime: 5000,
    placeholderData: (previous) => previous,
  });
  const isTunnelSupported = useTunnelSupportCheck(enabled);
  const hosts = (hostsQuery.data as any[] | undefined) || [];
  const tunnels = (tunnelsQuery.data as any[] | undefined) || [];

  return useMemo(() => ({
    ...buildNetworkMapModel({ hosts, tunnels, isTunnelSupported }),
    loading: hostsQuery.isLoading || tunnelsQuery.isLoading,
  }), [hosts, tunnels, isTunnelSupported, hostsQuery.isLoading, tunnelsQuery.isLoading]);
}

/**
 * 整页用的：主机、隧道，再加规则和落地目标。
 *
 * 落地目标只给管理员：把海外目标的位置画出来，等于把别的租户在往哪儿转发透给能看到
 * 共享隧道的人。规则列表租户也拿（rules.list 服务端按人过滤），只是不定位目标。
 */
export function useNetworkMapPageModel(options: { enabled: boolean; withTargets: boolean }) {
  const { enabled, withTargets } = options;
  const hostsQuery = trpc.hosts.options.useQuery(undefined, {
    enabled,
    refetchInterval: pollingInterval("normal"),
    staleTime: 5000,
    placeholderData: (previous) => previous,
  });
  const tunnelsQuery = trpc.tunnels.options.useQuery(undefined, {
    enabled,
    refetchInterval: pollingInterval("normal"),
    staleTime: 5000,
    placeholderData: (previous) => previous,
  });
  const rulesQuery = trpc.rules.list.useQuery({ scope: "all" }, {
    enabled,
    refetchInterval: pollingInterval("slow"),
    staleTime: 15_000,
    // rules.list 的返回是个联合类型，推不出 previous 的类型，显式标一下
    placeholderData: (previous: any) => previous,
  });
  const isTunnelSupported = useTunnelSupportCheck(enabled);
  const hosts = (hostsQuery.data as any[] | undefined) || [];
  const tunnels = (tunnelsQuery.data as any[] | undefined) || [];
  const rules = (rulesQuery.data as any[] | undefined) || [];
  // 定位落地目标：去重、最多 100 个（rules.targetGeoBatch 的上限），一天缓存 —— IP 不会天天搬家
  const targetAddresses = useMemo(() => (
    withTargets
      ? Array.from(new Set(rules.map((rule) => String(rule?.targetIp || "").trim()).filter(Boolean))).slice(0, 100)
      : []
  ), [rules, withTargets]);
  const geoQuery = trpc.rules.targetGeoBatch.useQuery({ targets: targetAddresses }, {
    enabled: enabled && targetAddresses.length > 0,
    staleTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const targetGeo = (geoQuery.data as TargetGeoRow[] | undefined) || [];

  return useMemo(() => ({
    ...buildNetworkMapModel({ hosts, tunnels, rules: withTargets || rules.length > 0 ? rules : [], targetGeo, isTunnelSupported }),
    loading: hostsQuery.isLoading || tunnelsQuery.isLoading,
    error: hostsQuery.error || tunnelsQuery.error || null,
  }), [hosts, tunnels, rules, targetGeo, withTargets, isTunnelSupported, hostsQuery.isLoading, tunnelsQuery.isLoading, hostsQuery.error, tunnelsQuery.error]);
}
