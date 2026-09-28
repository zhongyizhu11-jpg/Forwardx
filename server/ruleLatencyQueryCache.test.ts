import assert from "node:assert/strict";
import test from "node:test";
import {
  clearRuleLatencyQueryCache,
  clearRuleTrafficAndLatencyQueryCaches,
  ruleLatencySeriesQueryCache,
  ruleTrafficQueryCache,
} from "./ruleLatencyQueryCache";

/**
 * TCPing 上报很频繁。原来每次上报都把流量缓存一起清掉，规则页的流量走势几乎每次轮询都重算。
 * 现在分开：写入延迟只清延迟缓存（带延迟的 24h 汇总也在这里），重置规则流量两份都清。
 */
test("写入延迟只清延迟缓存，流量缓存保留；重置流量两份都清", async () => {
  let trafficLoads = 0;
  let latencyLoads = 0;
  const loadTraffic = () => ruleTrafficQueryCache.get("t", { ttlMs: 60_000 }, async () => ++trafficLoads);
  const loadLatency = () => ruleLatencySeriesQueryCache.get("l", { ttlMs: 60_000 }, async () => ++latencyLoads);

  clearRuleTrafficAndLatencyQueryCaches();
  await loadTraffic();
  await loadLatency();
  assert.deepEqual([trafficLoads, latencyLoads], [1, 1]);

  clearRuleLatencyQueryCache();
  await loadTraffic();
  await loadLatency();
  assert.deepEqual([trafficLoads, latencyLoads], [1, 2], "TCPing 写入后流量缓存不该被清");

  clearRuleTrafficAndLatencyQueryCaches();
  await loadTraffic();
  await loadLatency();
  assert.deepEqual([trafficLoads, latencyLoads], [2, 3], "重置流量要把两份都清掉");
  clearRuleTrafficAndLatencyQueryCaches();
});
