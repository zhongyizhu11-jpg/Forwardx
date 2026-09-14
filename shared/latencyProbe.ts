import { normalizeForwardRuleProtocol } from "./forwardTypes";

export type LinkProbeMethod = "tcp" | "ping";
export type RuleLatencyProbeMethod = "tcping" | "ping";

export function isUdpOnlyProtocol(protocol: unknown) {
  return normalizeForwardRuleProtocol(protocol) === "udp";
}

export function linkProbeMethodForProtocol(protocol: unknown): LinkProbeMethod {
  return isUdpOnlyProtocol(protocol) ? "ping" : "tcp";
}

export function ruleLatencyProbeMethodForProtocol(protocol: unknown): RuleLatencyProbeMethod {
  return isUdpOnlyProtocol(protocol) ? "ping" : "tcping";
}

export function linkProbeMethodForRule(rule: any): LinkProbeMethod {
  return linkProbeMethodForProtocol(rule?.protocol);
}

export function ruleLatencyProbeMethodForRule(rule: any): RuleLatencyProbeMethod {
  return ruleLatencyProbeMethodForProtocol(rule?.protocol);
}

export function isRuleLatencyReportMethodCompatible(protocol: unknown, method: unknown) {
  const expected = ruleLatencyProbeMethodForProtocol(protocol);
  const actual = String(method || "").trim().toLowerCase();
  if (expected === "ping") return actual === "ping";
  return !actual || actual === expected;
}

export function normalizeLinkProbeMethod(method: unknown): LinkProbeMethod {
  return String(method || "").trim().toLowerCase() === "ping" ? "ping" : "tcp";
}

export type ProbeCounts = { probeCount: number; probeSuccesses: number };

/**
 * 把 Agent 报上来的探测计数收进可信区间，两处链路状态（隧道多入口、隧道自动选路）
 * 原来各存一份一样的实现。
 *
 * probeSuccesses 没报的时候按 isTimeout 兜底 —— 老版本 Agent 只报「超时了没」，
 * 不报成功几次，这里把它翻译成「一次没成 / 全成」，否则老 Agent 的链路会显示成
 * 0% 可用。成功数再夹进 [0, probeCount]，免得一个坏上报把丢包率算成负的。
 */
export function normalizeProbeCounts(input: {
  probeCount?: number | null;
  probeSuccesses?: number | null;
  isTimeout?: boolean;
}): ProbeCounts {
  const rawCount = Number(input.probeCount);
  const probeCount = Number.isInteger(rawCount) && rawCount >= 1 && rawCount <= 1024 ? rawCount : 1;
  const rawSuccesses = Number(input.probeSuccesses);
  const hasSuccesses = input.probeSuccesses !== undefined && input.probeSuccesses !== null
    && Number.isInteger(rawSuccesses);
  let probeSuccesses = hasSuccesses ? rawSuccesses : (input.isTimeout ? 0 : probeCount);
  probeSuccesses = Math.max(0, Math.min(probeCount, probeSuccesses));
  return { probeCount, probeSuccesses };
}
