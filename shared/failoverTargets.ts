/**
 * 主备目标的解析与上限，全站唯一一份。
 *
 * 原来有两份一模一样的 `parseFailoverTargets`：一份在规则 CRUD（面板存的时候用），
 * 一份在 Agent 心跳（下发给机器的时候用）。而且两份的上限写法不一样 —— CRUD 那份
 * 用 `MAX_FAILOVER_TARGETS`，心跳那份写死 `10`。
 *
 * 今天两个数**碰巧**相等，所以没出事。但这是一次改动就会静默分家的写法：把上限调到
 * 15，面板会收下 15 个目标、Agent 只拿到前 10 个，剩下 5 个不报错、不提示、只是永远
 * 不生效。主备是拿来兜底的，兜底本身悄悄少一半，是最不该发生的那种坏法。
 */
export const MAX_FAILOVER_TARGETS = 10;

export type FailoverTarget = { targetIp: string; targetPort: number };

export function parseFailoverTargets(raw: unknown): FailoverTarget[] {
  if (!raw || typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((target) => ({ targetIp: String(target?.targetIp || "").trim(), targetPort: Number(target?.targetPort) }))
      .filter((target) => target.targetIp && target.targetPort >= 1 && target.targetPort <= 65535)
      .slice(0, MAX_FAILOVER_TARGETS);
  } catch {
    return [];
  }
}
