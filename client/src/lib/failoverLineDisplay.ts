import { describeFailoverActiveLine, type FailoverActiveLine } from "@shared/failoverActiveLine";
import { parseFailoverTargets } from "@shared/failoverTargets";
import { normalizeFailoverStrategy, type FailoverStrategy } from "@/lib/ruleTransfer";

/**
 * 规则行上那一小块主备状态该说什么。
 *
 * 原来列表上只有一个「主备 2」的计数徽标 —— 它回答的是「配了几条」，而人想
 * 知道的是「现在走的是哪条」。配了主备和没配主备在列表上长得几乎一样，等于
 * 这个功能配完就看不见了。
 */

export type FailoverLineTone = "idle" | "backup" | "warn" | "unreported";

export type FailoverLineDisplay = {
  /** 徽标上的短文案。 */
  text: string;
  /** 鼠标悬停/读屏用的完整说明。 */
  title: string;
  tone: FailoverLineTone;
  backupCount: number;
  strategy: FailoverStrategy;
  active: FailoverActiveLine | null;
};

const strategyText: Record<FailoverStrategy, string> = {
  fallback: "主备",
  round_robin: "轮询",
  random: "随机",
  ip_hash: "IP哈希",
};

export function describeFailoverLineDisplay(
  rule: {
    failoverEnabled?: unknown;
    failoverStrategy?: unknown;
    failoverTargets?: unknown;
    targetIp?: unknown;
    targetPort?: unknown;
    failoverActiveTarget?: unknown;
    failoverActiveAt?: unknown;
  },
  nowSeconds?: number,
): FailoverLineDisplay | null {
  if (!rule?.failoverEnabled) return null;

  const strategy = normalizeFailoverStrategy(rule?.failoverStrategy);
  const backupCount = parseFailoverTargets(rule?.failoverTargets)
    .filter((target) => target.targetIp && target.targetPort > 0).length;
  const active = describeFailoverActiveLine(rule as any, nowSeconds);
  const label = strategyText[strategy] || "主备";

  // 还没有任何上报：多半是 Agent 版本不够，主备的新能力在它上面是收下了不执行。
  if (!active) {
    return {
      text: `${label} ${backupCount}`,
      title: `已配 ${backupCount} 条备用出站。Agent 还没报过当前走哪条 —— 需要 Agent 2.2.196 及以上。`,
      tone: "unreported",
      backupCount, strategy, active: null,
    };
  }

  if (active.unknown) {
    return {
      text: `${label} · ${active.target}`,
      title: `Agent 报的当前出站 ${active.target} 不在这条规则的出站清单里，多半是刚改过配置、Agent 还没跟上。`,
      tone: "warn",
      backupCount, strategy, active,
    };
  }

  const staleNote = active.stale ? "（心跳超过 10 分钟没再确认，可能已经不是现在的样子）" : "";
  return {
    text: `${label} · ${active.label}`,
    title: `当前走${active.label}（${active.target}），共 ${backupCount} 条备用出站。${staleNote}`,
    tone: active.stale ? "warn" : active.onBackup ? "backup" : "idle",
    backupCount, strategy, active,
  };
}
