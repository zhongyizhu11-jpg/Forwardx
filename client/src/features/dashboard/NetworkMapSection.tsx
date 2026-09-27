import { useMemo } from "react";

import { NetworkMap, type NetworkMapLink, type NetworkMapNode } from "@/components/network/NetworkMap";
import { tunnelHealthFromAvailability } from "@/features/links/tunnelHealth";
import { hostGeoCoordinate } from "@/lib/hostGeo";
import { pollingInterval } from "@/lib/polling";
import { getTunnelHopIds } from "@/lib/tunnelDisplay";
import { trpc } from "@/lib/trpc";
import { TUNNEL_PROTOCOLS, normalizeForwardProtocolSettings } from "@shared/forwardTypes";
import { buildLinkAvailabilityIndex } from "@shared/linkAvailability";
import { formatAgo } from "@shared/dashboardAttention";
import { describeNetworkHealth, type NetworkHealth } from "@shared/networkHealth";

/**
 * 首页的「网络地图」：这个账号看得到的主机和它们之间的隧道。
 *
 * 数据用的是各页已经在用的两条轻量列表（hosts.options / tunnels.options），不新加接口。
 * 隧道的状态和隧道页一样从 linkAvailability 算 —— 这里红的，点进隧道页也是红的。
 *
 * 一台主机都没有时整块不出现：那是「快速开始」的事，一张空地图什么也说不了。
 */
function hostNote(host: any, now: number, linkCount: number): string | null {
  if (host?.isOnline === false || host?.isOnline === 0) {
    const seen = host?.lastHeartbeat ? new Date(host.lastHeartbeat).getTime() : NaN;
    return Number.isFinite(seen) && seen > 0 ? `离线 · ${formatAgo(now - seen)}` : "离线";
  }
  if (host?.lastHeartbeat == null && host?.isOnline !== true) return "还没接入";
  return linkCount > 0 ? `${linkCount} 条线路` : "在线";
}

function hostHealth(host: any): NetworkHealth {
  if (host?.isOnline === true || host?.isOnline === 1) return "healthy";
  if (host?.lastHeartbeat == null) return "unknown";
  return "down";
}

export type NetworkMapModel = {
  nodes: NetworkMapNode[];
  links: NetworkMapLink[];
  /** 隧道总数，包括画不出来的那些 —— 页头「N 条线路」用这个数 */
  linkTotal: number;
  /** 两端里至少一端是这个账号看不到的主机的隧道数；它们存在、有状态，只是没法画成线 */
  hiddenLinkCount: number;
  legend: { healthy: number; degraded: number; down: number; standby: number };
};

/**
 * 纯函数：把 hosts.options / tunnels.options 变成地图要画的点和线。
 *
 * 两条规则和隧道页保持一致，否则同一条隧道在首页和隧道页会是两种颜色：
 *
 * 一、协议开关。管理员在设置里停用了某个隧道协议时，隧道页把那条隧道标成红的
 *     （isTunnelSupported → down），这里也一样，所以 supported 要一路传进去。
 *
 * 二、看不见的主机。普通用户用共享隧道时，服务端会把不在他主机范围里的那一端
 *     抹掉（linkAccessView），但 availability 还在。这种隧道**不能当不存在**：
 *     它照样计入线路数和图例，只是画不成一条线（线要两个点）。看得见的那一端的
 *     「N 条线路」注脚也照样算上它。
 */
export function buildNetworkMapModel(input: {
  hosts: any[];
  tunnels: any[];
  now?: number;
  isTunnelSupported?: (tunnel: any) => boolean;
}): NetworkMapModel {
  const { hosts, tunnels, isTunnelSupported } = input;
  const now = input.now ?? Date.now();
  const index = buildLinkAvailabilityIndex({ hosts, tunnels, now, isTunnelSupported });
  const linkCountByHost = new Map<number, number>();
  const links: NetworkMapLink[] = [];
  const legend = { healthy: 0, degraded: 0, down: 0, standby: 0 };
  let hiddenLinkCount = 0;
  for (const tunnel of tunnels) {
    const path: number[] = getTunnelHopIds(tunnel).map((id: unknown) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0);
    const state = index.tunnelAvailabilityById.get(Number(tunnel.id));
    const health = tunnelHealthFromAvailability(state?.status ?? tunnel?.availability?.status, {
      enabled: tunnel?.isEnabled !== false,
      supported: isTunnelSupported ? isTunnelSupported(tunnel) !== false : undefined,
    });
    const token = describeNetworkHealth(health).token;
    if (token === "healthy") legend.healthy += 1;
    else if (token === "warn") legend.degraded += 1;
    else if (token === "down") legend.down += 1;
    else legend.standby += 1;
    for (const hostId of new Set(path)) linkCountByHost.set(hostId, (linkCountByHost.get(hostId) || 0) + 1);
    if (path.length < 2) {
      hiddenLinkCount += 1;
      continue;
    }
    links.push({
      id: Number(tunnel.id),
      name: String(tunnel.name || `隧道 #${tunnel.id}`),
      path,
      health,
      latencyMs: typeof tunnel?.lastLatencyMs === "number" ? tunnel.lastLatencyMs : null,
    });
  }
  const nodes: NetworkMapNode[] = hosts.map((host) => ({
    id: Number(host.id),
    name: String(host.name || host.ip || host.ipv4 || `主机 #${host.id}`),
    health: hostHealth(host),
    note: hostNote(host, now, linkCountByHost.get(Number(host.id)) || 0),
    geo: hostGeoCoordinate(host),
  }));
  return { nodes, links, linkTotal: tunnels.length, hiddenLinkCount, legend };
}

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
  // 协议开关和隧道页读同一份设置；隧道页那边 staleTime 是 0，这里跟着不缓存。
  const settingsQuery = trpc.system.getSettings.useQuery(undefined, { enabled, staleTime: 0 });
  const hosts = (hostsQuery.data as any[] | undefined) || [];
  const tunnels = (tunnelsQuery.data as any[] | undefined) || [];
  const forwardProtocols = (settingsQuery.data as any)?.forwardProtocols;

  return useMemo(() => {
    const protocolSettings = normalizeForwardProtocolSettings(forwardProtocols);
    const isTunnelSupported = (tunnel: any) => {
      const key = String(tunnel?.mode || "").toLowerCase();
      return (TUNNEL_PROTOCOLS as readonly string[]).includes(key)
        && protocolSettings[key as keyof typeof protocolSettings] !== false;
    };
    return {
      ...buildNetworkMapModel({ hosts, tunnels, isTunnelSupported }),
      loading: hostsQuery.isLoading || tunnelsQuery.isLoading,
    };
  }, [hosts, tunnels, forwardProtocols, hostsQuery.isLoading, tunnelsQuery.isLoading]);
}

export function NetworkMapSection({ enabled = true, onOpen }: { enabled?: boolean; onOpen: (href: string) => void }) {
  const model = useNetworkMapModel(enabled);
  if (!enabled || model.nodes.length === 0) return null;
  const legendItems = [
    { key: "healthy", label: "正常", count: model.legend.healthy, color: "var(--fx-accent)" },
    { key: "degraded", label: "降级", count: model.legend.degraded, color: "var(--fx-warn)" },
    { key: "down", label: "中断", count: model.legend.down, color: "var(--fx-down)" },
    { key: "standby", label: "停用", count: model.legend.standby, color: "var(--fx-standby)" },
  ].filter((item) => item.count > 0);

  return (
    <section
      aria-label="网络地图"
      className="fx-netmap-card flex min-w-0 flex-col overflow-hidden rounded-[var(--fx-radius-surface)] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)]"
    >
      <div className="flex items-center justify-between gap-2 px-4 pt-3.5">
        <span className="text-primary-type font-semibold text-foreground">网络地图</span>
        <span className="text-meta tabular-nums text-muted-foreground">{model.nodes.length} 台主机 · {model.linkTotal} 条线路</span>
      </div>
      <NetworkMap
        nodes={model.nodes}
        links={model.links}
        onSelectNode={() => onOpen("/hosts")}
        onSelectLink={() => onOpen("/tunnels")}
      />
      {legendItems.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-3.5 text-meta text-[var(--fx-text-secondary)]">
          {legendItems.map((item) => (
            <span key={item.key} className="inline-flex items-center gap-1.5 tabular-nums">
              <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: item.color }} />
              {item.label} {item.count}
            </span>
          ))}
          {model.hiddenLinkCount > 0 ? (
            <span className="tabular-nums text-muted-foreground">{model.hiddenLinkCount} 条经过你看不到的主机，没有画出来</span>
          ) : null}
        </div>
      ) : (
        <div className="px-4 pb-3.5 text-meta text-muted-foreground">还没有线路。把两台主机连起来，这里就会出现第一条线。</div>
      )}
    </section>
  );
}
