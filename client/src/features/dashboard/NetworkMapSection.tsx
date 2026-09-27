import { useMemo } from "react";

import { NetworkMap, type NetworkMapLink, type NetworkMapNode } from "@/components/network/NetworkMap";
import { tunnelHealthFromAvailability } from "@/features/links/tunnelHealth";
import { hostGeoCoordinate } from "@/lib/hostGeo";
import { pollingInterval } from "@/lib/polling";
import { getTunnelHopIds } from "@/lib/tunnelDisplay";
import { trpc } from "@/lib/trpc";
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
  const hosts = (hostsQuery.data as any[] | undefined) || [];
  const tunnels = (tunnelsQuery.data as any[] | undefined) || [];

  return useMemo(() => {
    const now = Date.now();
    const index = buildLinkAvailabilityIndex({ hosts, tunnels, now });
    const linkCountByHost = new Map<number, number>();
    const links: NetworkMapLink[] = [];
    for (const tunnel of tunnels) {
      const path: number[] = getTunnelHopIds(tunnel).map((id: unknown) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0);
      if (path.length < 2) continue;
      const state = index.tunnelAvailabilityById.get(Number(tunnel.id));
      const health = tunnelHealthFromAvailability(state?.status ?? tunnel?.availability?.status, { enabled: tunnel?.isEnabled !== false });
      for (const hostId of new Set(path)) linkCountByHost.set(hostId, (linkCountByHost.get(hostId) || 0) + 1);
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
    const legend = { healthy: 0, degraded: 0, down: 0, standby: 0 };
    for (const link of links) {
      const token = describeNetworkHealth(link.health).token;
      if (token === "healthy") legend.healthy += 1;
      else if (token === "warn") legend.degraded += 1;
      else if (token === "down") legend.down += 1;
      else legend.standby += 1;
    }
    return { nodes, links, legend, loading: hostsQuery.isLoading || tunnelsQuery.isLoading };
  }, [hosts, tunnels, hostsQuery.isLoading, tunnelsQuery.isLoading]);
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
        <span className="text-meta tabular-nums text-muted-foreground">{model.nodes.length} 台主机 · {model.links.length} 条线路</span>
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
        </div>
      ) : (
        <div className="px-4 pb-3.5 text-meta text-muted-foreground">还没有线路。把两台主机连起来，这里就会出现第一条线。</div>
      )}
    </section>
  );
}
