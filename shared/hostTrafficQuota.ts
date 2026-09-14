/**
 * 主机那一层的流量口径：机房账单怎么算，面板就怎么算。
 *
 * 这里的已用量来自 Agent 报上来的**系统级网卡计数**，不是按转发规则求和 ——
 * 订阅里的直连条目、这台机器上跑的别的服务、面板完全不知情的流量，全都在里面。
 * 机房就是按网卡算的，而「还剩多少」这种数报小了等于没报：人以为还有余量，
 * 机房那边已经停机了。
 *
 * 抽出来共用是因为这套算法原来在三处各写了一遍（主机卡片、主机监控、主机列表）。
 * 同一台机器的「已用」在三个页面上算法各一份，早晚会有一处漏改；而这个数决定的是
 * 「我是不是快被停机了」，两个页面给出不同答案比给错答案更让人不敢信。
 */
export type HostTrafficMeasureMode = "outbound" | "both" | "max";

export const HOST_TRAFFIC_MEASURE_MODE_LABELS: Record<HostTrafficMeasureMode, string> = {
  outbound: "仅出向",
  both: "双向",
  max: "取最大值",
};

/** 认不出来的一律当双向 —— 那是最保守的一个（算出来的已用量最大）。 */
export function normalizeHostTrafficMeasureMode(value: unknown): HostTrafficMeasureMode {
  return value === "outbound" || value === "max" ? value : "both";
}

/**
 * 这台机器按机房口径已经用掉多少字节。
 *
 * 拿不到计数（Agent 还没报过）时返回 0，而不是猜一个 —— 「还没有数」和「用了 0」
 * 在界面上要能分得出来，那是调用方的事，这里不替它编。
 */
export function hostTrafficUsedBytes(
  traffic: { bytesIn?: unknown; bytesOut?: unknown } | null | undefined,
  mode: unknown,
): number {
  const bytesIn = Math.max(0, Number(traffic?.bytesIn) || 0);
  const bytesOut = Math.max(0, Number(traffic?.bytesOut) || 0);
  switch (normalizeHostTrafficMeasureMode(mode)) {
    case "outbound": return bytesOut;
    case "max": return Math.max(bytesIn, bytesOut);
    default: return bytesIn + bytesOut;
  }
}

/** 用掉了百分之几。没设额度就没有分母，返回 null 而不是 0 —— 那是两回事。 */
export function hostTrafficPercent(usedBytes: number, limitBytes: unknown): number | null {
  const limit = Math.max(0, Number(limitBytes) || 0);
  if (limit <= 0) return null;
  return Math.round((Math.max(0, usedBytes) / limit) * 100);
}
