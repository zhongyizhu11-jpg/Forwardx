import { useMemo } from "react";

import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";

/**
 * 首页网络地图的原始数据：主机、隧道两条轻量列表（hosts.options / tunnels.options）和隧道协议开关。
 *
 * 单独一个文件、只引 trpc：它跟着首页首屏包走，页面一挂上就和别的请求一起发出去；
 * 把它们变成地图模型（中文地名表、线路状态……）的 networkMapModel 跟着地图卡片 lazy 进来。
 */

/** 协议开关一分钟内不重拉：它只在管理员改设置时变，过期了回到首页会在后台再取一次 */
const FORWARD_PROTOCOLS_STALE_MS = 60_000;
const EMPTY: any[] = [];

export type NetworkMapData = {
  hosts: any[];
  tunnels: any[];
  /** system.forwardProtocols；还没回来是 undefined（按默认全开算） */
  forwardProtocols: unknown;
  /** 主机列表有结论了（取到了，或者取失败了）：在这之前不知道这张图该不该出现 */
  hostsSettled: boolean;
  loading: boolean;
};

export function useNetworkMapData(enabled: boolean): NetworkMapData {
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
  // 协议开关和隧道页是同一份设置，但这里只取这一项，不拉整份 getSettings（证书、首页 HTML 都在里面）
  const protocolsQuery = trpc.system.forwardProtocols.useQuery(undefined, {
    enabled,
    staleTime: FORWARD_PROTOCOLS_STALE_MS,
    refetchOnWindowFocus: false,
  });
  const hosts = (hostsQuery.data as any[] | undefined) || EMPTY;
  const tunnels = (tunnelsQuery.data as any[] | undefined) || EMPTY;
  const forwardProtocols = protocolsQuery.data;
  const hostsSettled = hostsQuery.data !== undefined || hostsQuery.isError;
  const loading = hostsQuery.isLoading || tunnelsQuery.isLoading;
  return useMemo(
    () => ({ hosts, tunnels, forwardProtocols, hostsSettled, loading }),
    [hosts, tunnels, forwardProtocols, hostsSettled, loading],
  );
}
