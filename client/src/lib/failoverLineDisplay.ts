import {
  describeRoutePolicy,
  describeRoutePolicyReport,
  type RoutePolicy,
  type RoutePolicyHost,
  type RoutePolicyReportText,
} from "@shared/routePolicy";

/**
 * 规则行上那一小块主备状态该说什么。
 *
 * 原来列表上只有一个「主备 2」的计数徽标 —— 它回答的是「配了几条」，而人想
 * 知道的是「现在走的是哪条」。配了主备和没配主备在列表上长得几乎一样，等于
 * 这个功能配完就看不见了。
 *
 * 判断全在 shared/routePolicy：走哪条、这份报告能信到什么程度、走的是不是按规矩
 * 该走的那条。这里只管压成徽标上的几个字和一个颜色。颜色不按「是不是在备用上」定 ——
 * 晚上按时段表走备用 1 是排好的，不是出事；没走首选才值得看一眼。
 */

export type FailoverLineTone = RoutePolicyReportText["tone"];

export type FailoverLineDisplay = {
  /** 徽标上的短文案。 */
  text: string;
  /** 鼠标悬停/读屏用的完整说明。 */
  title: string;
  tone: FailoverLineTone;
  policy: RoutePolicy;
};

const strategyText: Record<RoutePolicy["strategy"], string> = {
  fallback: "主备",
  round_robin: "轮询",
  random: "随机",
  ip_hash: "IP哈希",
};

export function describeFailoverLineDisplay(
  rule: Parameters<typeof describeRoutePolicy>[0],
  host?: RoutePolicyHost,
  nowMs?: number,
): FailoverLineDisplay | null {
  const policy = describeRoutePolicy(rule, { host, nowMs });
  if (!policy) return null;
  const report = describeRoutePolicyReport(policy, { nowMs });
  const label = strategyText[policy.strategy];
  const activeIndex = policy.report.kind === "current" || policy.report.kind === "lastSwitch" ? policy.report.index : null;
  return {
    text: activeIndex !== null ? `${label} · ${policy.lines[activeIndex].label}` : `${label} ${policy.lines.length - 1}`,
    // 每一句自己带句号，只有第一句（「现在走 备用 1，21:30 起」）是短语，补一个。
    title: `${report.text}。${report.note || ""}${policy.divergence || ""}`,
    tone: report.tone,
    policy,
  };
}
