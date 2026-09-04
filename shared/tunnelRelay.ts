export const TUNNEL_RELAY_MODES = ["chain", "failover", "aggregate"] as const;

export type TunnelRelayMode = (typeof TUNNEL_RELAY_MODES)[number];

export const AGENT_FORWARDX_RELAY_FAILOVER_VERSION = "2.2.160";

/**
 * Single-connection multipath aggregation is a ForwardX protocol feature, so an
 * Agent older than this cannot run an aggregate tunnel.
 */
export const AGENT_FORWARDX_RELAY_AGGREGATE_VERSION = "2.2.194";

export const TUNNEL_RELAY_MODE_LABELS: Record<TunnelRelayMode, string> = {
  chain: "串行中转 - 逐跳转发",
  failover: "中转故障转移 - 择一可用",
  aggregate: "带宽叠加 - 多中转并行",
};

export const TUNNEL_RELAY_MODE_HINTS: Record<TunnelRelayMode, string> = {
  chain: "流量按顺序经过每一台中转，最终到达出口。",
  failover: "入口每次只用一台中转，故障时切换到下一台。",
  aggregate: "单条连接被拆分到全部中转并行传输，由出口重组，可用带宽接近各中转之和。",
};

export function normalizeTunnelRelayMode(value: unknown): TunnelRelayMode {
  const normalized = String(value || "").trim().toLowerCase();
  return (TUNNEL_RELAY_MODES as readonly string[]).includes(normalized)
    ? normalized as TunnelRelayMode
    : "chain";
}

export function tunnelRelayFailoverSupported(mode: unknown) {
  const normalized = String(mode || "").trim().toLowerCase();
  return normalized === "forwardx" || ["tls", "wss", "tcp", "mtls", "mwss", "mtcp"].includes(normalized);
}

/**
 * Bandwidth aggregation splits one connection across the relays and reassembles
 * it at the exit, which only the ForwardX protocol implements. GOST transports
 * can fail over between relays but cannot stripe a single stream across them.
 */
export function tunnelRelayAggregateSupported(mode: unknown) {
  return String(mode || "").trim().toLowerCase() === "forwardx";
}

export function tunnelRelayCandidates<T>(hops: T[]) {
  return Array.isArray(hops) && hops.length >= 3 ? hops.slice(1, -1) : [];
}

export function isTunnelRelayFailover(tunnel: any, hops: any[]) {
  return normalizeTunnelRelayMode(tunnel?.relayMode) === "failover"
    && tunnelRelayFailoverSupported(tunnel?.mode)
    && tunnelRelayCandidates(hops).length >= 2;
}

/**
 * True when this tunnel stripes each client connection over every relay.
 *
 * Aggregation needs at least two relays to have anything to combine; with one
 * relay the tunnel behaves as an ordinary single-path chain.
 */
export function isTunnelRelayAggregate(tunnel: any, hops: any[]) {
  return normalizeTunnelRelayMode(tunnel?.relayMode) === "aggregate"
    && tunnelRelayAggregateSupported(tunnel?.mode)
    && tunnelRelayCandidates(hops).length >= 2;
}

/**
 * True when the relays sit side by side rather than in series, so each one
 * dials the final exit and the entry addresses them all.
 *
 * Failover and aggregation share this topology and differ only in how the entry
 * uses it: failover picks one relay per connection, aggregation uses them all at
 * once.
 */
export function tunnelRelayUsesParallelRelays(tunnel: any, hops: any[]) {
  return isTunnelRelayFailover(tunnel, hops) || isTunnelRelayAggregate(tunnel, hops);
}

/** Minimum relays before a side-by-side relay mode has anything to work with. */
export const TUNNEL_RELAY_PARALLEL_MIN_RELAYS = 2;

export type TunnelRelayModeAvailability = {
  available: boolean;
  /** Empty when available; otherwise why the mode cannot be picked. */
  reason: string;
};

/**
 * Why each side-by-side relay mode is or is not selectable for a hop list.
 *
 * The panel keeps unavailable modes visible and disabled rather than hiding
 * them, so the reason is part of the result: a hidden control gives no way to
 * discover the mode exists or what it needs.
 */
export function tunnelRelayModeAvailability(options: {
  relayCount: number;
  aggregateSupported: boolean;
}): { failover: TunnelRelayModeAvailability; aggregate: TunnelRelayModeAvailability } {
  const relayCount = Math.max(0, Math.floor(Number(options.relayCount) || 0));
  const hasEnoughRelays = relayCount >= TUNNEL_RELAY_PARALLEL_MIN_RELAYS;
  const relayCountReason = `需要至少 ${TUNNEL_RELAY_PARALLEL_MIN_RELAYS} 台中转，当前 ${relayCount} 台`;
  return {
    failover: {
      available: hasEnoughRelays,
      reason: hasEnoughRelays ? "" : relayCountReason,
    },
    aggregate: {
      // The protocol check comes first: telling an operator to add relays would
      // be wrong when the transport cannot stripe a connection at all.
      available: hasEnoughRelays && !!options.aggregateSupported,
      reason: !options.aggregateSupported
        ? "仅 ForwardX 隧道支持中转带宽叠加"
        : hasEnoughRelays
          ? ""
          : relayCountReason,
    },
  };
}
