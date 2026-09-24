import type { FailoverStrategy } from "@/lib/ruleTransfer";
import { parseFailoverEndpoint } from "@shared/failoverTargets";
import { isValidForwardPort, isValidTargetHost } from "@shared/forwardRuleForm";
import { formatPolicyDuration } from "@shared/routePolicy";

/*
  主备线路的「人话」版本：编辑框里那句「按现在这套设置，流量会怎么走」，
  以及「高级设置」折起来时挂在折叠条上的摘要。

  原来开了主备，迎面是三大块、十几个控件：探测目标、四种策略、人工指定、时段表、
  自动择优、切换时间、恢复观察、最短驻留……每一个都有道理，可第一次用的人只想知道
  一件事：「主线路挂了，会不会自动换到备用？」这句话就是回答它的 —— 不用先读懂
  任何一个控件，就知道现在这套设置会怎么做。

  说法和 Agent 的真实行为逐字对应（agent/main.go 的 failoverProxy）：
    - 每 5 秒对每条线路连一次 TCP；连续失败满「挂了就切」的秒数才判它坏了；
    - 但新连接拨不通时当场就判它坏了，并立刻改拨下一条 —— 不用等满那个秒数；
    - 坏了的线路要连续正常满「恢复观察」的秒数才重新启用；
    - 主备模式下「恢复后切回首选」开着才会切回来。
*/

export const FAILOVER_DEFAULTS = {
  failoverSeconds: 60,
  recoverSeconds: 120,
  failoverMinHoldSeconds: 0,
  autoFailback: true,
} as const;

/** 四种分配方式：选项上直接写它会怎么做，不写「IP 哈希」这种实现名词。 */
export const FAILOVER_STRATEGY_CHOICES: ReadonlyArray<{ value: FailoverStrategy; label: string; hint: string }> = [
  { value: "fallback", label: "主备（推荐）", hint: "平时只走主线路，出问题才换备用" },
  { value: "round_robin", label: "轮流", hint: "新连接轮流走每一条，把流量分摊开" },
  { value: "random", label: "随机", hint: "新连接随机挑一条能用的" },
  { value: "ip_hash", label: "按访客固定", hint: "同一个来源 IP 总走同一条，适合要保持登录的服务" },
];

export function failoverStrategyChoiceLabel(strategy: FailoverStrategy): string {
  return FAILOVER_STRATEGY_CHOICES.find((choice) => choice.value === strategy)?.label.replace("（推荐）", "") || "主备";
}

export type FailoverPlainInput = {
  strategy: FailoverStrategy;
  /** 填好了的备用线路条数（空行不算）。 */
  backupCount: number;
  failoverSeconds: number;
  recoverSeconds: number;
  autoFailback: boolean;
};

/** 一两句大白话：按现在这套设置，流量会怎么走。 */
export function describeFailoverPlainly(input: FailoverPlainInput): string {
  const backups = Math.max(0, Math.floor(input.backupCount));
  if (backups === 0) return "还没有备用线路。至少加一条，主线路出问题时才有地方可换。";
  const failover = formatPolicyDuration(input.failoverSeconds || FAILOVER_DEFAULTS.failoverSeconds);
  const recover = formatPolicyDuration(input.recoverSeconds || FAILOVER_DEFAULTS.recoverSeconds);
  const broken = `新连接连不上，或连续 ${failover}检查不通`;
  if (input.strategy === "fallback") {
    const next = backups === 1 ? "就换到备用 1" : "就换到备用 1，备用 1 也不行再往下换";
    const back = input.autoFailback
      ? `主线路恢复后稳定 ${recover}，自动切回来。`
      : "换走之后就一直走新的那条，不会自动切回主线路，除非它也出问题。";
    return `平时都走主线路。主线路出问题（${broken}），${next}。${back}`;
  }
  const lines = `主线路和 ${backups} 条备用`;
  const skip = `哪条出问题（${broken}）就先跳过它，恢复后稳定 ${recover}再用回来。`;
  if (input.strategy === "round_robin") return `每个新连接轮流走${lines}，把流量分摊开。${skip}`;
  if (input.strategy === "random") return `每个新连接从${lines}里随机挑一条。${skip}`;
  return `同一个访客（来源 IP）总走同一条线路，适合要保持登录状态的服务。那条出问题时（${broken}），这个访客会被换到别的线路。`;
}

export type FailoverAdvancedInput = {
  strategy: FailoverStrategy;
  failoverSeconds: number;
  recoverSeconds: number;
  failoverMinHoldSeconds: number;
  autoFailback: boolean;
  failoverProbeTarget: string;
  /** 备用线路里有没有哪一行填了探测地址。 */
  hasLineProbe: boolean;
  scheduleWindows: number;
  pinned: boolean;
  preferFastest: boolean;
};

/**
 * 「高级设置」折起来时，折叠条上挂的摘要：只列改过默认值的项。
 * 空数组 = 全是默认值。折起来也看得见里面动过什么 —— 收纳不是藏。
 */
export function summarizeFailoverAdvanced(input: FailoverAdvancedInput): string[] {
  const parts: string[] = [];
  if (input.strategy !== "fallback") parts.push(`分配：${failoverStrategyChoiceLabel(input.strategy)}`);
  if (input.strategy === "fallback") {
    if (input.pinned) parts.push("人工指定中");
    if (input.scheduleWindows > 0) parts.push(`时段表 ${input.scheduleWindows} 段`);
    if (input.preferFastest) parts.push("自动择优");
  }
  if ((input.failoverSeconds || FAILOVER_DEFAULTS.failoverSeconds) !== FAILOVER_DEFAULTS.failoverSeconds) {
    parts.push(`挂了 ${formatPolicyDuration(input.failoverSeconds)}就切`);
  }
  if ((input.recoverSeconds || FAILOVER_DEFAULTS.recoverSeconds) !== FAILOVER_DEFAULTS.recoverSeconds) {
    parts.push(`恢复观察 ${formatPolicyDuration(input.recoverSeconds)}`);
  }
  if (input.strategy === "fallback" && input.failoverMinHoldSeconds > 0) {
    parts.push(`最短驻留 ${formatPolicyDuration(input.failoverMinHoldSeconds)}`);
  }
  if (input.strategy === "fallback" && !input.autoFailback) parts.push("不自动切回");
  if (input.failoverProbeTarget.trim() || input.hasLineProbe) parts.push("自定探测地址");
  return parts;
}

/** 备用线路输入框的一行拆成「地址」「探测地址」两半；多出来的都算进探测那一半，交给提交时的校验去报错。 */
export function splitFailoverRow(line: string): { address: string; probe: string } {
  const parts = String(line || "").trim().split(/\s+/).filter(Boolean);
  return { address: parts[0] || "", probe: parts.slice(1).join(" ") };
}

export function joinFailoverRow(row: { address: string; probe: string }): string {
  const address = row.address.trim();
  const probe = row.probe.trim();
  // 地址清空了就整行清空：只剩一个探测地址的话，下次拆开它会被当成地址。
  if (!address) return "";
  return probe ? `${address} ${probe}` : address;
}

/**
 * 输入框原文 → 一行一条。空文本也给一行空的：打开主备就有一个框等着填，
 * 不用先找「添加」按钮。
 */
export function failoverRowsOf(text: string): string[] {
  return text ? text.split(/\r?\n/) : [""];
}

/**
 * 每一行该叫「备用几」：按它前面有几条填好的来数。空行算作下一条的位置 ——
 * 填上之后它就是这个编号，和人工指定、时段表里的「备用 N」对得上。
 */
export function failoverRowNumbers(rows: string[]): number[] {
  let filled = 0;
  return rows.map((row) => {
    const number = filled + 1;
    if (row.trim()) filled += 1;
    return number;
  });
}

/**
 * 一格地址哪里不对；没填、或者填对了返回 null。
 *
 * 和提交时的校验说同一种话，只是当场就说 —— 原来要等点了「保存」才弹一句
 * 「第 2 行：请按 地址:端口 格式填写」，人还得回头数自己填的是第几行。
 */
export function failoverAddressError(address: string): string | null {
  const text = address.trim();
  if (!text) return null;
  const parsed = parseFailoverEndpoint(text);
  if (!parsed) return null;
  if ("error" in parsed) return parsed.error;
  if (!isValidTargetHost(parsed.host)) return "地址格式不对";
  if (!isValidForwardPort(parsed.port)) return "端口要在 1–65535 之间";
  return null;
}
