import assert from "node:assert/strict";
import test from "node:test";

import { formatBitrate, formatLatency, formatUptime, summarizeHostSeries, summarizeLatencySeries, sumTraffic, usageTone } from "./networkMapSeries";

test("主机序列：取最后一个有值的点当「现在」，空洞画成 0", () => {
  const vitals = summarizeHostSeries([
    { at: 1, cpuUsage: 10, memoryUsage: 40, memoryUsed: 1_000, diskUsage: 30, diskUsed: 3, diskTotal: 10, networkSpeedIn: 100, networkSpeedOut: 50, uptime: 100 },
    { at: 2, cpuUsage: null, memoryUsage: null, memoryUsed: null, diskUsage: null, diskUsed: null, diskTotal: null, networkSpeedIn: null, networkSpeedOut: null, uptime: null },
    { at: 3, cpuUsage: 25, memoryUsage: 45, memoryUsed: 1_200, diskUsage: 31, diskUsed: 3.1, diskTotal: 10, networkSpeedIn: 200, networkSpeedOut: 80, uptime: 300 },
  ]);
  assert.deepEqual(vitals.cpuSeries, [10, 0, 25]);
  assert.equal(vitals.cpuNow, 25);
  assert.equal(vitals.memoryPercent, 45);
  assert.equal(vitals.netInNow, 200);
  assert.equal(vitals.uptimeSeconds, 300);
  assert.equal(vitals.sampleCount, 3);
  assert.equal(summarizeHostSeries(undefined).cpuNow, null);
});

test("延迟序列：只看 total 那条，超时是 null，成功率按探测计数算", () => {
  const stats = summarizeLatencySeries([
    { latencyMs: 10, recordedAt: "2026-09-29T00:00:00Z", probeCount: 10, probeSuccesses: 10, seriesKey: "total" },
    { latencyMs: 900, recordedAt: "2026-09-29T00:01:00Z", probeCount: 10, probeSuccesses: 10, seriesKey: "hop:2" },
    { latencyMs: null, isTimeout: true, recordedAt: "2026-09-29T00:02:00Z", probeCount: 10, probeSuccesses: 0, seriesKey: "total" },
    { latencyMs: 30, recordedAt: "2026-09-29T00:01:00Z", probeCount: 10, probeSuccesses: 8, seriesKey: "total" },
  ]);
  assert.deepEqual(stats.series, [10, 30, null], "按时间排序，超时是 null，别的子线路不算");
  assert.equal(stats.latest, 30);
  assert.equal(stats.avg, 20);
  assert.equal(stats.max, 30);
  assert.equal(Math.round(stats.jitter! * 100) / 100, 14.14);
  assert.equal(stats.successRate, 60);
  assert.equal(stats.probeTotal, 30);
});

test("延迟序列：没有探测计数的老数据，一行算一次探测", () => {
  const stats = summarizeLatencySeries([
    { latencyMs: 5, recordedAt: 1 },
    { latencyMs: null, isTimeout: true, recordedAt: 2 },
  ]);
  assert.equal(stats.successRate, 50);
  assert.equal(stats.jitter, null, "只有一个样本算不出抖动");
  assert.equal(summarizeLatencySeries([]).successRate, null);
});

test("流量汇总：按规则过滤后相加", () => {
  const rows = [
    { ruleId: 1, bytesIn: 100, bytesOut: 10 },
    { ruleId: 2, bytesIn: 50, bytesOut: null },
    { ruleId: 3, bytesIn: 7, bytesOut: 7 },
  ];
  assert.deepEqual(sumTraffic(rows, [1, 2]), { bytesIn: 150, bytesOut: 10 });
  assert.deepEqual(sumTraffic(rows), { bytesIn: 157, bytesOut: 17 });
});

test("格式化：运行时间、速率、延迟、用量档位", () => {
  assert.equal(formatUptime(37 * 86_400 + 4 * 3_600), "37 天 4 小时");
  assert.equal(formatUptime(2 * 3_600 + 15 * 60), "2 小时 15 分");
  assert.equal(formatUptime(20), "刚启动");
  assert.equal(formatUptime(null), "—");
  assert.equal(formatBitrate(12.5e6 / 8), "12.5 Mbps");
  assert.equal(formatBitrate(2e9 / 8), "2.00 Gbps");
  assert.equal(formatLatency(7.26), "7.3 ms");
  assert.equal(formatLatency(156.4), "156 ms");
  assert.equal(usageTone(50), "ok");
  assert.equal(usageTone(75), "warn");
  assert.equal(usageTone(92, 80, 90), "down");
});
