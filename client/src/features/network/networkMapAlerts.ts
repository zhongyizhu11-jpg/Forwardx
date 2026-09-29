import { formatAgo } from "@shared/dashboardAttention";

import type { NetworkMapModel } from "./networkMapModel";

/**
 * 网络地图的「需要关注」。
 *
 * 首页那块「需要关注」是服务端算的（dashboardAttention：主机掉线、隧道没在运行、转发组…），
 * 这里不复用它的行 —— 地图页要的是**能在图上聚焦**的东西：每条告警都得知道该把哪几台
 * 主机、哪几条线亮出来、点开哪个抽屉。这些只有地图模型自己知道，所以在客户端从模型里
 * 直接推，和图上画的用同一份数据、同一组判据：图上红的，这里就有一条。
 */

export type NetworkMapAlertSeverity = "error" | "warning";

export type NetworkMapAlert = {
  id: string;
  severity: NetworkMapAlertSeverity;
  title: string;
  detail: string;
  /** 右边那个小动作的文字（「看逐跳」「升级 Agent」） */
  action: string;
  focus: { hosts: number[]; tunnels: number[]; targets: string[]; rules: number[] };
  open: { view: "node" | "link" | "target"; id: number | string };
};

/** 延迟高于这个值算「需要关注」。跨洋线路 150 ms 是正常的，之后可按隧道单独设。 */
export const NETWORK_MAP_LATENCY_WARN_MS = 150;

const SEVERITY_ORDER: Record<NetworkMapAlertSeverity, number> = { error: 0, warning: 1 };
/** 同一档里按「从根上往下」：主机 → 隧道 → 规则。机器掉了，挂在它上面的隧道跟着报，人先看到根因。 */
const KIND_ORDER = ["host", "tunnel", "rule"] as const;

export function buildNetworkMapAlerts(model: NetworkMapModel, now = Date.now()): NetworkMapAlert[] {
  const rows: Array<NetworkMapAlert & { kind: (typeof KIND_ORDER)[number] }> = [];
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const hostName = (id: number | null | undefined) => (id ? nodeById.get(id)?.name : null) || (id ? `主机 #${id}` : "看不到的主机");
  const linksThrough = (hostId: number) => model.links.filter((link) => link.path.includes(hostId)).map((link) => link.id);

  for (const node of model.nodes) {
    if (node.health !== "down") continue;
    rows.push({
      kind: "host",
      id: `host-offline:${node.id}`,
      severity: "error",
      title: `${node.name} 离线`,
      detail: [node.region, node.lastHeartbeat ? `最后在线 ${formatAgo(now - node.lastHeartbeat)}` : "没有心跳", node.linkCount > 0 ? `${node.linkCount} 条线路受影响` : null]
        .filter(Boolean).join(" · "),
      action: "看主机",
      focus: { hosts: [node.id], tunnels: linksThrough(node.id), targets: [], rules: [] },
      open: { view: "node", id: node.id },
    });
  }

  for (const link of model.links) {
    const ends = `${hostName(link.path[0])} → ${hostName(link.path[link.path.length - 1])}`;
    if (link.fxpIssues.length > 0) {
      rows.push({
        kind: "tunnel",
        id: `tunnel-fxp:${link.id}`,
        severity: "error",
        title: `${link.name}：FXP 版本过旧`,
        detail: link.fxpIssues.join("；"),
        action: "升级 Agent",
        focus: { hosts: link.path, tunnels: [link.id], targets: [], rules: [] },
        open: { view: "link", id: link.id },
      });
      continue;
    }
    if (link.health === "down") {
      rows.push({
        kind: "tunnel",
        id: `tunnel-down:${link.id}`,
        severity: "error",
        title: `${link.name} 中断`,
        detail: [link.availabilityMessage || "探测不可达", ends].filter(Boolean).join(" · "),
        action: "看链路",
        focus: { hosts: link.path, tunnels: [link.id], targets: [], rules: [] },
        open: { view: "link", id: link.id },
      });
      continue;
    }
    if (link.health === "degraded") {
      rows.push({
        kind: "tunnel",
        id: `tunnel-degraded:${link.id}`,
        severity: "warning",
        title: `${link.name} 降级`,
        detail: [link.availabilityMessage || "部分节点不可用", ends].filter(Boolean).join(" · "),
        action: "看链路",
        focus: { hosts: link.path, tunnels: [link.id], targets: [], rules: [] },
        open: { view: "link", id: link.id },
      });
    }
    if (typeof link.latencyMs === "number" && link.latencyMs > NETWORK_MAP_LATENCY_WARN_MS && link.health !== "standby") {
      rows.push({
        kind: "tunnel",
        id: `tunnel-latency:${link.id}`,
        severity: "warning",
        title: `${link.name} 延迟 ${Math.round(link.latencyMs)} ms`,
        detail: `高于 ${NETWORK_MAP_LATENCY_WARN_MS} ms 预警阈值（${ends}）`,
        action: "看延迟",
        focus: { hosts: link.path, tunnels: [link.id], targets: [], rules: [] },
        open: { view: "link", id: link.id },
      });
    }
  }

  for (const rule of model.rules) {
    if (!rule.protocolBlockReason || rule.enabled) continue;
    rows.push({
      kind: "rule",
      id: `rule-blocked:${rule.id}`,
      severity: "warning",
      title: `${rule.name} 被系统停用`,
      detail: [rule.protocolBlockReason, `在 ${hostName(rule.hostId)} 上 · :${rule.sourcePort}`].join(" · "),
      action: "看主机",
      focus: { hosts: [rule.hostId], tunnels: rule.tunnelId ? [rule.tunnelId] : [], targets: [rule.targetKey], rules: [rule.id] },
      open: { view: "node", id: rule.hostId },
    });
  }

  return rows
    .sort((a, b) => {
      const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (bySeverity !== 0) return bySeverity;
      const byKind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
      if (byKind !== 0) return byKind;
      return a.id.localeCompare(b.id);
    })
    .map(({ kind: _kind, ...alert }) => alert);
}
