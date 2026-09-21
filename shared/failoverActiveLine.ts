import { parseFailoverTargets, formatFailoverEndpoint, type FailoverTarget } from "./failoverTargets";

/**
 * 「这条规则现在实际走的是哪条出站」。
 *
 * 规则级主备是数据面做的：Agent 自己探、自己切，毫秒级，不经面板。代价是
 * 面板原先完全看不到结果 —— 配了主备，列表上和没配长得一模一样，只能事后
 * 去日志里翻 `[Failover]`。这份判定把心跳带回来的 `failoverActiveTarget`
 * 对回规则自己的出站清单，换成一个能直接显示的序号和称呼。
 *
 * 前后端共用一份：列表、详情、通知如果各写各的，同一条规则会出现「面板说走
 * 主线、Telegram 说走备线」。
 */

/** 超过这个时长没有新的心跳确认，就不再声称自己知道现在走哪条。 */
export const FAILOVER_ACTIVE_STALE_SECONDS = 600;

export type FailoverActiveLine = {
  /** 0 = 主出站，1.. = 第几条备用出站；-1 = 报上来的地址不在清单里。 */
  index: number;
  /** 「主线路」「备线 1」，或认不出来时的原始地址。 */
  label: string;
  /** 正在走备线。用来决定要不要把这一条显示成需要注意的状态。 */
  onBackup: boolean;
  /** 报上来的地址对不上任何一条出站 —— 多半是刚改过配置、Agent 还没跟上。 */
  unknown: boolean;
  /** 心跳太久没确认过，显示的东西可能已经不是现在的样子。 */
  stale: boolean;
  /** 原始上报地址。 */
  target: string;
};

export function failoverLineLabel(index: number, target: string) {
  if (index === 0) return "主线路";
  if (index > 0) return `备线 ${index}`;
  return target || "未知出站";
}

/** 出站清单：主出站永远排第 0 位，后面接 failoverTargets 的顺序。 */
export function failoverLineEndpoints(rule: {
  targetIp?: unknown;
  targetPort?: unknown;
  failoverTargets?: unknown;
}): string[] {
  const main = formatFailoverEndpoint(String(rule?.targetIp || ""), Number(rule?.targetPort || 0));
  const backups = parseFailoverTargets(rule?.failoverTargets)
    .filter((target: FailoverTarget) => target.targetIp && target.targetPort > 0)
    .map((target: FailoverTarget) => formatFailoverEndpoint(target.targetIp, target.targetPort));
  return [main, ...backups];
}

export function describeFailoverActiveLine(
  rule: {
    failoverEnabled?: unknown;
    targetIp?: unknown;
    targetPort?: unknown;
    failoverTargets?: unknown;
    failoverActiveTarget?: unknown;
    failoverActiveAt?: unknown;
  },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): FailoverActiveLine | null {
  if (!rule?.failoverEnabled) return null;
  const target = String(rule?.failoverActiveTarget || "").trim();
  // 没有上报过就是没有上报过，不要拿「默认走主线」去填 —— 那会把「Agent 还是
  // 旧版、根本不报」显示成「一切正常走主线」，正好骗过最该被发现的那种情况。
  if (!target) return null;

  const endpoints = failoverLineEndpoints(rule);
  const index = endpoints.findIndex((endpoint) => endpoint.toLowerCase() === target.toLowerCase());
  const activeAt = Math.max(0, Math.floor(Number(rule?.failoverActiveAt || 0)));
  return {
    index,
    label: failoverLineLabel(index, target),
    onBackup: index > 0,
    unknown: index < 0,
    stale: activeAt > 0 && nowSeconds - activeAt > FAILOVER_ACTIVE_STALE_SECONDS,
    target,
  };
}
