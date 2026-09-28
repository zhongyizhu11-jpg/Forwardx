import * as db from "./db";
import { ENV } from "./env";

/*
  共享主机上的端口保护：普通用户在别人的主机（通常是管理员的共享节点）上开监听，
  不能占用 1-1023 的系统端口，也不能占用面板自己的端口。iptables DNAT 在 22 端口
  上生效会直接劫持管理员的 SSH；主机端口策略默认不限制，所以这里单独兜底。
  用户自己的主机不受限制，管理员也不受限制。
*/
export const TENANT_SYSTEM_PORT_MAX = 1023;

function panelListenPorts() {
  const ports = new Set<number>();
  for (const value of [ENV.port, ENV.publicPort]) {
    const port = Math.floor(Number(value || 0));
    if (port > 0 && port <= 65535) ports.add(port);
  }
  return ports;
}

export function assertTenantListenPortAllowed(input: {
  actor: { id: number; role?: string | null };
  host: { userId?: number | null } | null | undefined;
  port: unknown;
  label?: string;
}) {
  if (input.actor.role === "admin") return;
  const port = Math.floor(Number(input.port || 0));
  if (!Number.isFinite(port) || port <= 0) return;
  if (input.host && Number(input.host.userId || 0) > 0 && Number(input.host.userId) === Number(input.actor.id)) return;
  const label = input.label || "监听端口";
  if (port <= TENANT_SYSTEM_PORT_MAX) {
    throw new Error(`${label} ${port} 是系统保留端口（1-${TENANT_SYSTEM_PORT_MAX}），共享主机上只有管理员可以使用，请换用 1024 以上的端口`);
  }
  if (panelListenPorts().has(port)) {
    throw new Error(`${label} ${port} 是面板自身使用的端口，共享主机上不能使用，请更换端口`);
  }
}

export async function assertTenantListenPortAllowedOnHosts(input: {
  actor: { id: number; role?: string | null };
  hostIds: Array<number | null | undefined>;
  port: unknown;
  label?: string;
}) {
  if (input.actor.role === "admin") return;
  const port = Math.floor(Number(input.port || 0));
  if (!Number.isFinite(port) || port <= 0) return;
  const hostIds = Array.from(new Set(input.hostIds.map((id) => Number(id || 0)).filter((id) => id > 0)));
  for (const hostId of hostIds) {
    const host = await db.getHostById(hostId);
    assertTenantListenPortAllowed({ actor: input.actor, host: host as any, port, label: input.label });
  }
}
