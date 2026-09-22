import type { DashboardAttentionRow } from "@shared/dashboardAttention";

/**
 * 链路页的六个 tab，按转发组的形态对上号。
 *
 * 点一条「转发链降级」却落在隧道 tab 上，人还得自己再找一遍 —— 那这个链接
 * 只替他省了一半的路。
 */
const LINK_SECTION_BY_GROUP_MODE: Record<string, string> = {
  chain: "chains",
  port: "ports",
  failover: "groups",
  entry: "entries",
  exit: "exits",
};

/**
 * 「需要关注」的每一行点进去落在哪一页。回 null 表示这一行不给链接。
 *
 * 租户进不了链路页（/tunnels 是管理员路由）：给租户的隧道和转发组行不给链接，
 * 行上也就不画箭头 —— 一个点下去必然被弹回首页的入口，比没有更糟。
 */
export function attentionHref(row: DashboardAttentionRow, options: { isAdmin: boolean }): string | null {
  switch (row.reason) {
    case "host-offline":
    case "host-never-connected":
      return "/hosts";
    case "tunnel-stopped":
      return options.isAdmin ? "/tunnels?tab=tunnels" : null;
    case "group-down":
    case "group-degraded":
      return options.isAdmin
        ? `/tunnels?tab=${LINK_SECTION_BY_GROUP_MODE[String(row.groupMode || "")] || "groups"}`
        : null;
    case "forward-stalled":
      return "/rules";
    case "forward-paused":
      /*
        给的是出路，不是原因所在的页面：到期和超额去「我的套餐」续期或加购，
        欠费去账单中心充值。管理员手动停的没有自助出路，不给链接。
        不指向商店 —— 商店可以被管理员关掉，「我的套餐」一直在。
      */
      if (row.pauseReason === "expired" || row.pauseReason === "traffic_limit") return "/subscriptions";
      if (row.pauseReason === "traffic_billing_balance") return "/wallet";
      return null;
    default:
      return null;
  }
}
