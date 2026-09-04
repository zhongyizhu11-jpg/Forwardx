/**
 * Health check method for forward group and entry group members.
 *
 * The panel probes each member from its own Agent to decide whether that member
 * still carries traffic. TCPing connects to a port on the target; ping measures
 * ICMP round-trip. Ping needs no port, and works against hosts that answer ICMP
 * but expose no reachable TCP port.
 */

export const FORWARD_GROUP_HEALTH_CHECK_METHODS = ["tcp", "ping"] as const;

export type ForwardGroupHealthCheckMethod = (typeof FORWARD_GROUP_HEALTH_CHECK_METHODS)[number];

export const FORWARD_GROUP_HEALTH_CHECK_METHOD_LABELS: Record<ForwardGroupHealthCheckMethod, string> = {
  tcp: "TCPing - 连接目标端口",
  ping: "Ping - ICMP 延迟",
};

export const FORWARD_GROUP_HEALTH_CHECK_METHOD_HINTS: Record<ForwardGroupHealthCheckMethod, string> = {
  tcp: "连接目标的 IP 和端口，能确认端口真的可用。目标必须写成 主机:端口。",
  ping: "只发 ICMP 探测延迟，不需要端口。适合目标不开放 TCP 端口、或只想看链路通断和延迟的场景。",
};

/** TCPing needs a port on the target; ping does not. */
export function healthCheckTargetNeedsPort(method: unknown) {
  return normalizeForwardGroupHealthCheckMethod(method) === "tcp";
}

export function normalizeForwardGroupHealthCheckMethod(value: unknown): ForwardGroupHealthCheckMethod {
  return String(value ?? "").trim().toLowerCase() === "ping" ? "ping" : "tcp";
}

/** Default probe target per method: TCPing carries a port, ping is host only. */
export function defaultHealthCheckTarget(method: unknown) {
  return healthCheckTargetNeedsPort(method) ? "www.189.cn:80" : "www.189.cn";
}

/** Placeholder shown in the target field for the selected method. */
export function healthCheckTargetPlaceholder(method: unknown) {
  return healthCheckTargetNeedsPort(method)
    ? "留空默认 www.189.cn:80，IPv6 用 [地址]:端口"
    : "留空默认 www.189.cn，IPv6 直接填地址";
}
