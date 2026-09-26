import { formatFailoverEndpoint } from "./failoverTargets";
import { routePathDial, routePathLabel, routePathsOf, type RouteGroupRule } from "./routeGroup";
import { timestampMillis } from "./timestamp";

/**
 * 「这条规则现在实际走的是哪条出站」。
 *
 * 规则级主备是数据面做的：Agent 自己探、自己切，毫秒级，不经面板。代价是
 * 面板原先完全看不到结果 —— 配了主备，列表上和没配长得一模一样，只能事后
 * 去日志里翻 `[Failover]`。这份判定把心跳带回来的 `failoverActiveTarget`
 * 对回规则自己的线路清单，换成一个能直接显示的序号和称呼。
 *
 * 前后端共用一份：列表、详情、通知如果各写各的，同一条规则会出现「面板说走
 * 主线、Telegram 说走备线」。
 */

export type FailoverActiveLine = {
  /** 0 = 主线路，1.. = 第几条备用线路；-1 = 报上来的地址不在清单里。 */
  index: number;
  /** 路径的名字（「主线路」「晚高峰线路」），或认不出来时的原始地址。 */
  label: string;
  /** 路径的稳定标识（routePaths 里的 key）；认不出来是 null。 */
  pathKey: string | null;
  /** 正在走备线。用来决定要不要把这一条显示成需要注意的状态。 */
  onBackup: boolean;
  /** 报上来的地址对不上任何一条出站 —— 多半是刚改过配置、Agent 还没跟上。 */
  unknown: boolean;
  /**
   * 从什么时候起走的这条（Unix 秒）。
   *
   * 它是「切到这条的时刻」（新版 Agent 每次心跳报的快照里也是这个意思），**不是**
   * 「最后一次确认的时刻」。上一版拿它判断「超过 10 分钟没确认就算过期」：一条切过去
   * 之后稳稳走了半小时的线路会被标成可疑；而且库里读出来的是 Date，Number() 得到的是
   * 毫秒，和秒相减永远是负数，这个判断其实从来没触发过。报告可不可信，看的是那台 Agent
   * 的版本和在不在线，见 shared/routePolicy。
   */
  since: number | null;
  /** 原始上报地址。 */
  target: string;
};

/**
 * 出站的称呼：「主线路」「备用 1」。
 *
 * 和编辑框里配置时的叫法一致。原来这里叫「主线路 / 备线 1」、时段表的复述叫「备用线路 1」、
 * 编辑框叫「备用 1」—— 同一条线三个名字，用户得自己对上号。
 */
export function failoverLineLabel(index: number, target: string) {
  if (index === 0) return "主线路";
  if (index > 0) return `备用 ${index}`;
  return target || "未知出站";
}

/**
 * 线路清单：每条路径入口 Agent 实际拨的地址，主线路永远排第 0 位。
 *
 * Agent 报上来的是它拨的地址（走中转的路径报的是第一跳中转上那条中继规则的地址），
 * 所以这里对的也是 dial，不是落地。还没解析出 dial 的路径给空串，对不上任何上报。
 */
export function failoverLineEndpoints(rule: RouteGroupRule): string[] {
  return routePathsOf(rule).map((path) => {
    const dial = routePathDial(path, rule);
    return dial ? formatFailoverEndpoint(dial.ip, dial.port) : "";
  });
}

export function describeFailoverActiveLine(
  rule: RouteGroupRule & {
    failoverActiveTarget?: unknown;
    failoverActiveAt?: unknown;
  },
): FailoverActiveLine | null {
  if (!rule?.failoverEnabled) return null;
  const target = String(rule?.failoverActiveTarget || "").trim();
  // 没有上报过就是没有上报过，不要拿「默认走主线」去填 —— 那会把「Agent 还是
  // 旧版、根本不报」显示成「一切正常走主线」，正好骗过最该被发现的那种情况。
  if (!target) return null;

  const paths = routePathsOf(rule);
  const endpoints = failoverLineEndpoints(rule);
  const index = endpoints.findIndex((endpoint) => endpoint && endpoint.toLowerCase() === target.toLowerCase());
  const sinceMs = timestampMillis(rule?.failoverActiveAt);
  return {
    index,
    label: index >= 0 ? routePathLabel(paths[index], index) : failoverLineLabel(index, target),
    pathKey: index >= 0 ? paths[index].key : null,
    onBackup: index > 0,
    unknown: index < 0,
    since: sinceMs > 0 ? Math.floor(sinceMs / 1000) : null,
    target,
  };
}
