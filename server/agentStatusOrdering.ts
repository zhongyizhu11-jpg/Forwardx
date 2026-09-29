const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const STATUS_ORDER_CACHE_MAX_SIZE = 20_000;
const STATUS_ORDER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function normalizeAgentStatusIssuedAt(value: unknown, now = Date.now()) {
  const issuedAt = Number(value || 0);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0 || issuedAt > now + MAX_FUTURE_SKEW_MS) return 0;
  return Math.floor(issuedAt);
}

export function agentStatusOrderingKey(hostIdValue: unknown, payload: Record<string, any>) {
  const hostId = Number(hostIdValue || 0);
  const statusType = String(payload?.statusType || (Number(payload?.ruleId) > 0 ? "rule" : "tunnel"));
  const resourceId = statusType === "runtime"
    ? String(payload?.forwardType || "runtime")
    : statusType === "tunnel"
      ? Number(payload?.tunnelId || 0)
      : Number(payload?.ruleId || 0);
  return `agent-status:${hostId}:${statusType}:${resourceId}`;
}

export class AgentStatusOrderGuard {
  private readonly latest = new Map<string, { issuedAt: number; seenAt: number }>();

  accept(key: string, value: unknown, now = Date.now()) {
    const issuedAt = normalizeAgentStatusIssuedAt(value, now);
    if (!key || issuedAt <= 0) return true;
    const current = this.latest.get(key);
    if (current && issuedAt < current.issuedAt) return false;
    this.expect(key, issuedAt, now);
    return true;
  }

  expect(key: string, value: unknown, now = Date.now()) {
    const issuedAt = normalizeAgentStatusIssuedAt(value, now);
    if (!key || issuedAt <= 0) return;
    const current = this.latest.get(key);
    this.latest.set(key, { issuedAt: Math.max(issuedAt, current?.issuedAt || 0), seenAt: now });
    if (this.latest.size > STATUS_ORDER_CACHE_MAX_SIZE) this.prune(now);
  }

  clear() {
    this.latest.clear();
  }

  private prune(now: number) {
    for (const [key, value] of this.latest) {
      if (now - value.seenAt > STATUS_ORDER_CACHE_TTL_MS) this.latest.delete(key);
    }
  }
}

export const agentStatusOrderGuard = new AgentStatusOrderGuard();

/** 内容没变的动作在这段时间内原样重发，不算一次新的下发（和心跳里整批 issuedAt 的复用窗口一致）。 */
const ACTION_ISSUE_REUSE_MS = 45 * 1000;

/**
 * 记住每条动作上一次下发时的内容摘要，决定这次下发要不要抬高 AgentStatusOrderGuard 的期望。
 *
 * 一条动作在 Agent 报回结果之前，下一次心跳会原样再发一遍（换隧道后旧入口的桥接就是：
 * 桥接没标成运行中之前每次心跳都重下）。批次里别的动作一变（比如第一批里还带着 FXP 入口组的
 * 重载，第二批没有了），整批的 issuedAt 就换成新的；要是把这个新 issuedAt 记成这条动作的期望，
 * Agent 对上一份 —— 内容一模一样 —— 的结果就会被守卫当成过期丢掉。生产日志里的
 * `[AgentStatus] ignored stale result ... key=agent-status:1:rule:2000000006` 就是这么来的：
 * 桥接起没起来、为什么没起来，面板永远收不到。内容没变的重发不抬高期望，上一份结果照样算数；
 * 内容变了（换了目标、换了命令）才抬，旧结果该丢还是丢。
 */
export class AgentActionIssueTracker {
  private readonly issued = new Map<string, { signature: string; seenAt: number }>();

  /** 这次下发要不要抬高期望：内容和上一次不一样，或者上一次是很久以前，才要。 */
  shouldExpect(key: string, signature: string, now = Date.now()): boolean {
    if (!key || !signature) return true;
    const current = this.issued.get(key);
    const changed = !current || current.signature !== signature || now - current.seenAt > ACTION_ISSUE_REUSE_MS;
    this.issued.set(key, { signature, seenAt: now });
    if (this.issued.size > STATUS_ORDER_CACHE_MAX_SIZE) this.prune(now);
    return changed;
  }

  /** 这台主机的期望状态整个作废（Agent 重连、面板重算）时，它的记录一起忘掉：下一次下发按新的算。 */
  forgetPrefix(prefix: string) {
    if (!prefix) return;
    for (const key of Array.from(this.issued.keys())) {
      if (key.startsWith(prefix)) this.issued.delete(key);
    }
  }

  clear() {
    this.issued.clear();
  }

  prune(now = Date.now()) {
    for (const [key, value] of this.issued) {
      if (now - value.seenAt > ACTION_ISSUE_REUSE_MS) this.issued.delete(key);
    }
  }
}

export const agentActionIssueTracker = new AgentActionIssueTracker();
