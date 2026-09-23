import { describeFailoverActiveLine, failoverLineEndpoints, failoverLineLabel } from "./failoverActiveLine";
import { readFailoverPin, type FailoverPin } from "./failoverPin";
import {
  describeFailoverScheduleDays,
  failoverScheduleWindowIndexAt,
  parseFailoverSchedule,
  parseScheduleMinutes,
} from "./failoverSchedule";
import { isAgentVersionAtLeast } from "./version";

/**
 * 一条主备规则的「路由策略」：此刻按什么规矩、首选哪条、实际走哪条。全站唯一一份。
 *
 * 选路是 Agent 在本地做的，规矩写死在 agent/main.go 的 priorityOrderLocked 里：
 *
 *     人工指定 > 时段表 > 自动择优 > 出站顺序
 *
 * 哪一层先给出答案，哪一层就决定「首选是谁」；首选挂了照样往下找，那是健康检查的事，
 * 和选路是正交的。这里把同一套规矩在面板上再算一遍 —— 不是为了替 Agent 做决定，是为了
 * 把「为什么走这条」说出来：界面上每一层是一行条件，此刻起作用的那一行高亮。
 *
 * 两件事要分开说，不能混成一句「现在走 X」：
 *
 *   · 首选（preferred）：面板按规矩算出来的。自动择优那一层面板算不了 —— 谁更快是
 *     Agent 实测的 —— 这时候首选是 null，不瞎猜。
 *   · 实际（report）：Agent 报上来的。新版 Agent 每次心跳报一遍，才能叫「现在」；
 *     2.2.196 只报切换事件，只能叫「最近一次切换」；机器离线就什么都不说。
 *
 * 两者不一致不一定是故障（首选那条可能正挂着、刚恢复还在观察、「恢复后切回」关着），
 * 所以不一致时只说确实可能的原因，不下结论。
 */

/** 探测目标、时段表、人工指定、自动择优、切换事件：Agent 2.2.196 起。更老的只认出站顺序。 */
export const ROUTE_POLICY_AGENT_VERSION = "2.2.196";
/** 每次心跳报「现在走哪条」：Agent 2.2.197 起。 */
export const ACTIVE_LINE_SNAPSHOT_AGENT_VERSION = "2.2.197";

export type RoutePolicyStrategy = "fallback" | "round_robin" | "random" | "ip_hash";

export type RoutePolicyLine = {
  /** 0 是主出站，1.. 是第几条备用出站 */
  index: number;
  /** 「主出站」「备用 1」 */
  label: string;
  endpoint: string;
  /** 按规矩此刻排在最前的那条。由自动择优决定时谁都不是 —— 面板不知道 Agent 测出来谁快。 */
  preferred: boolean;
  /** Agent 报的正在走的那条（报告能用时才有）。 */
  active: boolean;
};

export type RoutePolicyConditionKind = "pin" | "schedule" | "fastest" | "order" | "spread";

export type RoutePolicyCondition = {
  kind: RoutePolicyConditionKind;
  key: string;
  /** 条件那一半：什么时候。 */
  when: string;
  /** 结果那一半：走哪条。 */
  then: string;
  /** 指向哪条出站；「按顺序」「择优」「分摊」这种不指向单独一条的是 null。 */
  targetIndex: number | null;
  /**
   * - deciding：此刻就是它在决定首选
   * - overridden：此刻本该轮到它，但被更靠前的一层压着（钉着的时候时段表命中了）
   * - idle：此刻不适用（不在时段内），或者只是兜底的顺序
   */
  state: "deciding" | "overridden" | "idle";
};

export type RoutePolicyGuard = {
  key: "failover" | "recover" | "hold";
  label: string;
  value: string;
};

export type RoutePolicyReport =
  /** 新版 Agent 每次心跳确认的「现在」 */
  | { kind: "current"; index: number; since: number | null }
  /** 2.2.196 只报切换事件：这是最近一次切换，之后换过规格或重启过的话已经回到主出站 */
  | { kind: "lastSwitch"; index: number; since: number | null }
  /** 报上来的地址不在出站清单里 —— 多半刚改过配置 */
  | { kind: "unlisted"; target: string }
  /** 新版 Agent，还没报上来（刚起来、刚改过） */
  | { kind: "pending" }
  /** 2.2.196，没有切换记录 —— 不能当成「一直走主出站」：这一版之前面板会丢事件 */
  | { kind: "noSwitch" }
  | { kind: "offline" }
  /** Agent 早于 2.2.196：不报告，也不执行时段表、人工指定、自动择优 */
  | { kind: "unsupported" };

export type RoutePolicy = {
  strategy: RoutePolicyStrategy;
  lines: RoutePolicyLine[];
  /** 从上往下就是优先级。 */
  conditions: RoutePolicyCondition[];
  guards: RoutePolicyGuard[];
  /** 按规矩此刻首选第几条；null = 由 Agent 按实测延迟定，或者本来就没有首选（轮询这类）。 */
  preferredIndex: number | null;
  deciding: RoutePolicyConditionKind | null;
  /** 此刻有效的人工指定（过期的、越界的不算）。 */
  pin: FailoverPin | null;
  report: RoutePolicyReport;
  /** 首选和实际走的不是同一条时，一句话说可能的原因。 */
  divergence: string | null;
  /** 配了、但在这台机器上不会生效的东西。 */
  warnings: string[];
};

export type RoutePolicyRule = {
  failoverEnabled?: unknown;
  forwardType?: unknown;
  protocol?: unknown;
  failoverStrategy?: unknown;
  targetIp?: unknown;
  targetPort?: unknown;
  failoverTargets?: unknown;
  failoverSchedule?: unknown;
  failoverMinHoldSeconds?: unknown;
  failoverPinnedIndex?: unknown;
  failoverPinnedUntil?: unknown;
  failoverPreferFastest?: unknown;
  failoverSeconds?: unknown;
  recoverSeconds?: unknown;
  autoFailback?: unknown;
  failoverActiveTarget?: unknown;
  failoverActiveAt?: unknown;
};

export type RoutePolicyHost = { isOnline?: unknown; agentVersion?: unknown } | null | undefined;

export type RoutePolicyOptions = {
  host?: RoutePolicyHost;
  nowMs?: number;
  /** 钟点怎么写。默认按运行环境的时区；测试里传固定的。 */
  timeZone?: string;
};

const STRATEGIES: RoutePolicyStrategy[] = ["fallback", "round_robin", "random", "ip_hash"];

function normalizeStrategy(value: unknown): RoutePolicyStrategy {
  const text = String(value || "").trim() as RoutePolicyStrategy;
  return STRATEGIES.includes(text) ? text : "fallback";
}

function truthy(value: unknown, fallback: boolean) {
  if (value === null || value === undefined) return fallback;
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

/** 「60 秒」「2 分钟」「1.5 小时」这类说法。 */
export function formatPolicyDuration(seconds: number): string {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  if (value < 120) return `${value} 秒`;
  if (value < 7200) return `${Math.round(value / 60)} 分钟`;
  const hours = value / 3600;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时`;
}

/** 钟点：同一天只写「21:30」，不是同一天带上日期。 */
export function formatPolicyClock(ms: number, nowMs: number, timeZone?: string): string {
  const parts = (at: number) => {
    const formatted = new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(at));
    const pick = (type: string) => formatted.find((part) => part.type === type)?.value || "";
    return { y: pick("year"), m: pick("month"), d: pick("day"), clock: `${pick("hour")}:${pick("minute")}` };
  };
  const at = parts(ms);
  const now = parts(nowMs);
  if (at.y === now.y && at.m === now.m && at.d === now.d) return at.clock;
  return `${at.m}月${at.d}日 ${at.clock}`;
}

function describeReport(
  rule: RoutePolicyRule,
  host: RoutePolicyHost,
  lineCount: number,
): RoutePolicyReport {
  const version = String(host?.agentVersion || "");
  if (host && version && !isAgentVersionAtLeast(version, ROUTE_POLICY_AGENT_VERSION)) return { kind: "unsupported" };
  if (!host || !truthy(host.isOnline, false)) return { kind: "offline" };
  const snapshots = isAgentVersionAtLeast(version, ACTIVE_LINE_SNAPSHOT_AGENT_VERSION);
  const active = describeFailoverActiveLine({ ...rule, failoverEnabled: true });
  if (!active) return snapshots ? { kind: "pending" } : { kind: "noSwitch" };
  if (active.unknown || active.index >= lineCount) return { kind: "unlisted", target: active.target };
  return { kind: snapshots ? "current" : "lastSwitch", index: active.index, since: active.since };
}

export function describeRoutePolicy(rule: RoutePolicyRule, options: RoutePolicyOptions = {}): RoutePolicy | null {
  if (!truthy(rule?.failoverEnabled, false)) return null;
  const nowMs = options.nowMs ?? Date.now();
  const clock = (ms: number) => formatPolicyClock(ms, nowMs, options.timeZone);
  const strategy = normalizeStrategy(rule.failoverStrategy);
  const endpoints = failoverLineEndpoints(rule);
  const lineCount = endpoints.length;
  const label = (index: number) => failoverLineLabel(index, endpoints[index] || "");
  const report = describeReport(rule, options.host, lineCount);
  const warnings: string[] = [];

  const failoverSeconds = Math.max(0, Math.floor(Number(rule.failoverSeconds) || 60));
  const recoverSeconds = Math.max(0, Math.floor(Number(rule.recoverSeconds) || 120));
  const autoFailback = truthy(rule.autoFailback, true);
  const minHoldSeconds = Math.max(0, Math.floor(Number(rule.failoverMinHoldSeconds) || 0));

  const conditions: RoutePolicyCondition[] = [];
  let preferredIndex: number | null = null;
  let deciding: RoutePolicyConditionKind | null = null;
  let pin: FailoverPin | null = null;

  if (strategy !== "fallback") {
    /*
      轮询、随机、哈希没有「首选是谁」：每条新连接各走各的。人工指定、时段表、自动择优
      在这几种策略下 Agent 都不看，保存时也会被清掉，所以这里只有一行。
    */
    const spread: Record<Exclude<RoutePolicyStrategy, "fallback">, string> = {
      round_robin: `轮流走这 ${lineCount} 条`,
      random: `从 ${lineCount} 条里随机挑一条`,
      ip_hash: "按来源 IP 固定分到其中一条",
    };
    conditions.push({ kind: "spread", key: "spread", when: "每条新连接", then: spread[strategy], targetIndex: null, state: "deciding" });
    deciding = "spread";
  } else {
    const supported = report.kind !== "unsupported";
    pin = readFailoverPin(rule, { nowMs, lineCount });
    const schedule = parseFailoverSchedule(rule.failoverSchedule);
    const windows = (schedule?.windows || []).filter((window) => window.targetIndex < lineCount);
    const matchedWindow = schedule ? failoverScheduleWindowIndexAt({ ...schedule, windows }, new Date(nowMs)) : null;
    const preferFastest = truthy(rule.failoverPreferFastest, false);

    // 按 Agent 的次序一层层往下找第一个给出答案的。Agent 太旧时这三层它都不认，只剩出站顺序。
    if (supported && pin) {
      deciding = "pin";
      preferredIndex = pin.index;
    } else if (supported && matchedWindow !== null) {
      deciding = "schedule";
      preferredIndex = windows[matchedWindow].targetIndex;
    } else if (supported && preferFastest) {
      deciding = "fastest";
      preferredIndex = null;
    } else {
      deciding = "order";
      preferredIndex = 0;
    }

    if (pin) {
      conditions.push({
        kind: "pin",
        key: "pin",
        when: pin.untilMs ? `人工指定，到 ${clock(pin.untilMs)}` : "人工指定，一直",
        then: `强制走 ${label(pin.index)}`,
        targetIndex: pin.index,
        state: deciding === "pin" ? "deciding" : "idle",
      });
    }
    windows.forEach((window, index) => {
      const crossesMidnight = (parseScheduleMinutes(window.to) ?? 0) <= (parseScheduleMinutes(window.from) ?? 0);
      const matched = index === matchedWindow;
      conditions.push({
        kind: "schedule",
        key: `schedule-${index}`,
        when: `${describeFailoverScheduleDays(window.days)} ${window.from}–${window.to}${crossesMidnight ? "（次日）" : ""}`,
        then: `首选 ${label(window.targetIndex)}`,
        targetIndex: window.targetIndex,
        state: matched && deciding === "schedule" ? "deciding" : matched && supported ? "overridden" : "idle",
      });
    });
    if (preferFastest) {
      conditions.push({
        kind: "fastest",
        key: "fastest",
        when: "按实测延迟",
        // 三道门槛写死在 Agent 里（failoverFastestMarginMs / Ratio / HoldSeconds），这里照抄。
        then: "挑明显更快的那条（快 20ms 且快 20%，连续 3 分钟）",
        targetIndex: null,
        state: deciding === "fastest" ? "deciding" : supported && (deciding === "pin" || deciding === "schedule") ? "overridden" : "idle",
      });
    }
    conditions.push({
      kind: "order",
      key: "order",
      when: conditions.length > 0 ? "其余时候" : "按顺序",
      then: endpoints.map((_, index) => label(index)).join(" → "),
      targetIndex: null,
      state: deciding === "order" ? "deciding" : "idle",
    });
    if (!supported && (pin || windows.length > 0 || preferFastest)) {
      warnings.push(`这台机器的 Agent 早于 ${ROUTE_POLICY_AGENT_VERSION}：人工指定、时段表、自动择优它都不认，只按出站顺序走。`);
    }
  }

  /*
    主备只在 gost 的 TCP 转发上跑（心跳下发时别的一律不带主备规格）。界面上存不出这种
    组合，但老数据里可能有 —— 那就照实说：配着，但机器上不会走主备。
  */
  const forwardType = String(rule.forwardType ?? "gost");
  const protocol = String(rule.protocol ?? "tcp");
  if (forwardType !== "gost" || protocol !== "tcp") {
    warnings.push("主备只在 gost 的 TCP 转发上生效。这条规则的转发方式或协议不是，机器上不会走主备；保存一次时主备会被关掉。");
  }

  const guards: RoutePolicyGuard[] = [
    { key: "failover", label: "挂了就切", value: `探测连续失败 ${formatPolicyDuration(failoverSeconds)}，或新连接拨不通` },
  ];
  if (strategy === "fallback") {
    guards.push(autoFailback
      ? { key: "recover", label: "切回首选", value: `首选那条恢复后稳定 ${formatPolicyDuration(recoverSeconds)}` }
      : { key: "recover", label: "不切回", value: "当前这条不出问题就一直走它" });
    if (minHoldSeconds > 0) {
      guards.push({ key: "hold", label: "最短驻留", value: `切过去之后至少走 ${formatPolicyDuration(minHoldSeconds)}` });
    }
  }

  const activeIndex = strategy === "fallback" && (report.kind === "current" || report.kind === "lastSwitch") ? report.index : null;
  let divergence: string | null = null;
  if (strategy === "fallback" && activeIndex !== null && preferredIndex !== null && activeIndex !== preferredIndex) {
    if (!autoFailback) {
      divergence = `首选是 ${label(preferredIndex)}，但「恢复后切回」关着：${label(activeIndex)} 不出问题就不会换过去。`;
    } else {
      const reasons = ["正挂着", `刚恢复还在观察（${formatPolicyDuration(recoverSeconds)}）`];
      if (minHoldSeconds > 0) reasons.push(`刚切过还在最短驻留（${formatPolicyDuration(minHoldSeconds)}）里`);
      divergence = `首选是 ${label(preferredIndex)}，没走它：它可能${reasons.join("、")}。`;
    }
  }

  return {
    strategy,
    lines: endpoints.map((endpoint, index) => ({
      index,
      label: label(index),
      endpoint,
      preferred: strategy === "fallback" && preferredIndex === index,
      active: activeIndex === index,
    })),
    conditions,
    guards,
    preferredIndex: strategy === "fallback" ? preferredIndex : null,
    deciding,
    pin,
    report,
    divergence,
    warnings,
  };
}

export type RoutePolicyReportText = {
  /** 「现在走 备用 1，21:30 起」 */
  text: string;
  /** 补一句这份报告能信到什么程度；没什么要补的是 null。 */
  note: string | null;
  /**
   * - normal：走的就是按规矩该走的那条（包括时段表、自动择优有意选的备用）
   * - deviated：没走首选 —— 多半首选那条出了事，值得看一眼
   * - warn：报上来的对不上清单
   * - muted：不知道
   *
   * 不按「是不是在备用上」定颜色：晚上按时段表走备用 1 是排好的，不是出事。
   */
  tone: "normal" | "deviated" | "warn" | "muted";
};

/** 「现在走哪条」那一句，给规则卡和策略面板共用。 */
export function describeRoutePolicyReport(policy: RoutePolicy, options: { nowMs?: number; timeZone?: string } = {}): RoutePolicyReportText {
  const nowMs = options.nowMs ?? Date.now();
  const since = (seconds: number | null) => seconds ? `，${formatPolicyClock(seconds * 1000, nowMs, options.timeZone)} 起` : "";
  const report = policy.report;
  const label = (index: number) => policy.lines[index]?.label || `第 ${index} 条`;
  const upgradeNote = `Agent 升级到 ${ACTIVE_LINE_SNAPSHOT_AGENT_VERSION} 后每次心跳确认。`;
  const lineTone = (index: number) => policy.preferredIndex !== null && index !== policy.preferredIndex ? "deviated" : "normal";
  // 轮询、随机、哈希没有「现在走哪条」：每条新连接各走各的，报一条出来只会误导。
  if (policy.strategy !== "fallback") {
    return { text: `每条新连接各走各的，共 ${policy.lines.length} 条`, note: null, tone: "normal" };
  }
  switch (report.kind) {
    case "current":
      return { text: `现在走 ${label(report.index)}${since(report.since)}`, note: null, tone: lineTone(report.index) };
    case "lastSwitch":
      return {
        text: `最近一次切到 ${label(report.index)}${since(report.since)}`,
        note: `这台 Agent 只在切换时报告：之后改过主备设置或重启过，就已经回到主出站了。${upgradeNote}`,
        tone: lineTone(report.index),
      };
    case "unlisted":
      return { text: `Agent 报的 ${report.target} 不在出站清单里`, note: "多半是刚改过配置，Agent 还没跟上。", tone: "warn" };
    case "pending":
      return { text: "等 Agent 报告现在走哪条", note: null, tone: "muted" };
    case "noSwitch":
      return { text: "没有切换记录", note: upgradeNote, tone: "muted" };
    case "offline":
      return { text: "机器离线，不知道现在走哪条", note: null, tone: "muted" };
    case "unsupported":
      return { text: `Agent 早于 ${ROUTE_POLICY_AGENT_VERSION}，不报告现在走哪条`, note: null, tone: "muted" };
  }
}

/** 钉住期限的几个常用选项（秒）。编辑框和策略面板共用，别各写一份。 */
export const PIN_DURATION_OPTIONS: Array<{ label: string; seconds: number | null }> = [
  { label: "30 分钟", seconds: 1800 },
  { label: "2 小时", seconds: 7200 },
  { label: "12 小时", seconds: 43200 },
  { label: "24 小时", seconds: 86400 },
  { label: "一直", seconds: null },
];

/** 钉住期限（Unix 秒）；null 是一直钉着。 */
export function pinUntilSeconds(durationSeconds: number | null, nowMs = Date.now()): number | null {
  if (durationSeconds === null) return null;
  return Math.floor(nowMs / 1000) + Math.max(60, Math.floor(durationSeconds));
}
