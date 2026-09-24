import assert from "node:assert/strict";
import test from "node:test";

import { calculateMonitorSummary } from "./HostMonitor";

/**
 * 公开监控页页头的「当前瞬时流量」。
 *
 * 离线机器的速率是掉线前最后两次采样算出来的，冻在那儿不动。原来一起加进「当前」——
 * 4 台全离线，页头照样写着 12.49 MB/s。累计流量是累计量，掉线不影响，照常加。
 */
test("当前瞬时流量只算在线的；累计流量全算", () => {
  const hosts = [
    { id: 1, isOnline: true },
    { id: 2, isOnline: false },
  ];
  const metrics = new Map<number, any>([
    [1, { networkSpeedIn: 100, networkSpeedOut: 200 }],
    [2, { networkSpeedIn: 5_000_000, networkSpeedOut: 9_000_000 }],
  ]);
  const traffic = new Map<number, any>([
    [1, { bytesIn: 10, bytesOut: 20 }],
    [2, { bytesIn: 1_000, bytesOut: 2_000 }],
  ]);
  const summary = calculateMonitorSummary(hosts, metrics, traffic);
  assert.equal(summary.currentTrafficIn, 100);
  assert.equal(summary.currentTrafficOut, 200);
  assert.equal(summary.totalTrafficIn, 1_010);
  assert.equal(summary.totalTrafficOut, 2_020);
  assert.equal(summary.onlineHosts, 1);
  assert.equal(summary.totalHosts, 2);
});

test("全部离线时当前速率是 0，不是最后一次的数", () => {
  const summary = calculateMonitorSummary(
    [{ id: 1, isOnline: false }],
    new Map([[1, { networkSpeedIn: 12_490_000, networkSpeedOut: 38_240_000 }]]),
    new Map(),
  );
  assert.equal(summary.currentTrafficIn, 0);
  assert.equal(summary.currentTrafficOut, 0);
});
