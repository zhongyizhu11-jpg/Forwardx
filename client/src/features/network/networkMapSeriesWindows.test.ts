import assert from "node:assert/strict";
import test from "node:test";

import { formatDelta, latencyWindows, periodDelta, trafficRateWindows } from "./networkMapSeries";

const now = 1_700_000_000_000;
const HOUR = 3_600_000;
const FIVE = 5 * 60_000;

test("速率：字节 ÷ 时长；只算这条隧道的规则；和前一段比", () => {
  const rows = [
    // 这一小时：规则 1 两个桶各 3 MB 入、1.5 MB 出
    { ruleId: 1, bucket: now - 50 * 60_000, bytesIn: 3_000_000, bytesOut: 1_500_000 },
    { ruleId: 1, bucket: new Date(now - 10 * 60_000).toISOString(), bytesIn: 3_000_000, bytesOut: 1_500_000 },
    // 别的规则不算
    { ruleId: 9, bucket: now - 10 * 60_000, bytesIn: 9e9, bytesOut: 9e9 },
    // 前一小时：4.5 MB 入
    { ruleId: 1, bucket: now - 90 * 60_000, bytesIn: 4_500_000, bytesOut: 0 },
  ];
  const result = trafficRateWindows(rows, { ruleIds: [1], nowMs: now, rangeMs: HOUR, bucketMs: FIVE });
  assert.equal(result.down.avg, 6_000_000 / 3600);
  assert.equal(result.up.avg, 3_000_000 / 3600);
  assert.equal(result.down.previousAvg, 4_500_000 / 3600);
  assert.ok(Math.abs(result.down.delta! - 33.333333) < 1e-4);
  assert.equal(result.up.delta, null, "前一段上行是 0，不算变化");
  assert.equal(result.down.series.length, 12);
  assert.equal(result.down.series[2], 3_000_000 / 300);
  assert.equal(result.down.series[10], 3_000_000 / 300);
  assert.equal(result.down.series[5], 0, "没有行的桶是 0");
});

test("速率：一行都没有时是 null（写「—」），不冒充 0", () => {
  const result = trafficRateWindows([], { ruleIds: [1], nowMs: now, rangeMs: HOUR, bucketMs: FIVE });
  assert.equal(result.down.avg, null);
  assert.deepEqual(result.down.series, []);
  assert.equal(result.down.delta, null);
});

test("延迟：这一段的统计和前一段的平均", () => {
  const rows = [
    { latencyMs: 40, recordedAt: now - 30 * 60_000, probeCount: 4, probeSuccesses: 4 },
    { latencyMs: 60, recordedAt: now - 10 * 60_000, probeCount: 4, probeSuccesses: 3 },
    { latencyMs: 25, recordedAt: now - 80 * 60_000 },
    { latencyMs: 999, recordedAt: now - 5 * HOUR },
  ];
  const result = latencyWindows(rows, { nowMs: now, rangeMs: HOUR });
  assert.equal(result.current.avg, 50);
  assert.equal(result.current.successRate, 87.5);
  assert.equal(result.previousAvg, 25);
  assert.equal(result.delta, 100);
});

test("变化百分比的写法", () => {
  assert.equal(periodDelta(10, 0), null);
  assert.equal(periodDelta(null, 3), null);
  assert.equal(formatDelta(12.345), "+12.3%");
  assert.equal(formatDelta(-3), "−3.0%");
  assert.equal(formatDelta(0), "±0.0%");
  assert.equal(formatDelta(null), null);
});
