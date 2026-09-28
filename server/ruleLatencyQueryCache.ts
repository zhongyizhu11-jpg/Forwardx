import { createQueryCache } from "./queryCache";

/**
 * 规则相关的两份查询缓存，按「数据会被谁弄旧」分开：
 *
 * - ruleTrafficQueryCache：只含字节数的结果（流量明细、走势、累计汇总）。
 *   只有重置规则流量会让它立刻失效，其余靠 TTL。
 * - ruleLatencySeriesQueryCache：凡是带延迟的结果（TCPing 走势、带最新延迟的 24h
 *   流量汇总）。每次 TCPing / 自测 / 调度器写入延迟都要清。
 *
 * 原来 TCPing 上报一次就把两份一起清掉，而 TCPing 上报很频繁 —— 流量缓存几乎
 * 从来活不到 TTL，规则页每次轮询都要重算走势。
 */
export const ruleTrafficQueryCache = createQueryCache(500);
export const ruleLatencySeriesQueryCache = createQueryCache(500);

/** 写入了新的延迟样本：只清带延迟的缓存，流量缓存不受影响。 */
export function clearRuleLatencyQueryCache() {
  ruleLatencySeriesQueryCache.clear();
}

/** 字节数和延迟都变了（例如重置规则流量会同时删 tcping_stats）：两份一起清。 */
export function clearRuleTrafficAndLatencyQueryCaches() {
  ruleTrafficQueryCache.clear();
  ruleLatencySeriesQueryCache.clear();
}
