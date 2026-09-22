import assert from "node:assert/strict";
import test from "node:test";

import { deriveHostVitals } from "./useHostVitals";

const metric = (over: Record<string, unknown> = {}) => ({
  cpuUsage: 18,
  memoryUsage: 42,
  diskUsage: 36,
  memoryUsed: 3_400_000_000,
  diskUsed: 72_000_000_000,
  diskTotal: 200_000_000_000,
  networkIn: 1_000_000,
  networkOut: 2_000_000,
  networkSpeedIn: 8_420_000,
  networkSpeedOut: 11_600_000,
  uptime: 1_400_000,
  recordedAt: "2026-09-22T02:34:56Z",
  ...over,
});

test("在线时占用率照实给", () => {
  const v = deriveHostVitals({ isOnline: true }, [metric()]);
  assert.equal(v.cpuPercent, 18);
  assert.equal(v.memoryPercent, 42);
  assert.equal(v.diskPercent, 36);
  assert.equal(v.health, "healthy");
});

test("离线时 CPU/内存/磁盘一律 null —— 不是 0，也不是最后那个值", () => {
  /*
    这是整个模块最要紧的一条。占用率是「此刻」的量，机器一掉线就冻在最后一次
    上报上。继续显示等于报了一个它没说过的数：一台断了三天的机器写着「CPU 18%」，
    看的人会以为它在跑。
  */
  const v = deriveHostVitals({ isOnline: false }, [metric()]);
  assert.equal(v.cpuPercent, null);
  assert.equal(v.memoryPercent, null);
  assert.equal(v.diskPercent, null);
  assert.notEqual(v.cpuPercent, 0, "更不能退化成 0");
});

test("离线时流量数字保留，只把标签改对", () => {
  // 和占用率相反：掉线前跑到哪儿是有用的线索，抹掉更糟。
  const v = deriveHostVitals({ isOnline: false }, [metric()]);
  assert.equal(v.speedIn, 8_420_000);
  assert.equal(v.speedOut, 11_600_000);
  assert.equal(v.speedLabel, "最后一次");

  const online = deriveHostVitals({ isOnline: true }, [metric()]);
  assert.equal(online.speedLabel, "当前");
});

test("从没上报过的机器是 unknown，不是故障", () => {
  // 一台刚加进来还没连上的机器不该报红 —— 它只是还没开始。
  const v = deriveHostVitals({ isOnline: false }, []);
  assert.equal(v.health, "unknown");
  assert.equal(v.cpuPercent, null);
});

test("上报过但现在离线，才是故障", () => {
  const v = deriveHostVitals({ isOnline: false }, [metric()]);
  assert.equal(v.health, "down");
});

test("没有 networkSpeed 字段时用两次采样算速率", () => {
  const now = new Date("2026-09-22T02:00:10Z").toISOString();
  const before = new Date("2026-09-22T02:00:00Z").toISOString();
  const v = deriveHostVitals({ isOnline: true }, [
    metric({ networkSpeedIn: null, networkSpeedOut: null, networkIn: 10_000_000, networkOut: 20_000_000, recordedAt: now }),
    metric({ networkSpeedIn: null, networkSpeedOut: null, networkIn: 9_000_000, networkOut: 18_000_000, recordedAt: before }),
  ]);
  assert.equal(v.speedIn, 100_000); // 1MB / 10s
  assert.equal(v.speedOut, 200_000);
});

test("计数器回绕不会算出负速率", () => {
  // Agent 重启后累计值从 0 开始，差值为负 —— 报一个负的速率比报 0 更难解释。
  const now = new Date("2026-09-22T02:00:10Z").toISOString();
  const before = new Date("2026-09-22T02:00:00Z").toISOString();
  const v = deriveHostVitals({ isOnline: true }, [
    metric({ networkSpeedIn: null, networkSpeedOut: null, networkIn: 5, networkOut: 5, recordedAt: now }),
    metric({ networkSpeedIn: null, networkSpeedOut: null, networkIn: 9_000_000, networkOut: 9_000_000, recordedAt: before }),
  ]);
  assert.equal(v.speedIn, 0);
  assert.equal(v.speedOut, 0);
});

test("只有一条采样且没有速率字段时，速率是未知而不是 0", () => {
  const v = deriveHostVitals({ isOnline: true }, [
    metric({ networkSpeedIn: null, networkSpeedOut: null }),
  ]);
  assert.equal(v.speedIn, null);
  assert.equal(v.speedOut, null);
});

test("没设流量上限时不编一个百分比出来", () => {
  const v = deriveHostVitals({ isOnline: true, trafficLimit: 0 }, [metric()], { bytesIn: 100, bytesOut: 200 });
  assert.equal(v.trafficPercent, null);
  assert.match(v.trafficUsageLabel, /不限/);
});

test("设了上限时给出用量和百分比", () => {
  const v = deriveHostVitals(
    { isOnline: true, trafficLimit: 1000, trafficMeasureMode: "both" },
    [metric()],
    { bytesIn: 300, bytesOut: 200 },
  );
  assert.equal(v.usedBytes, 500);
  assert.equal(v.trafficPercent, 50);
  assert.match(v.trafficUsageLabel, /50%/);
});

test("运行时间的标签跟着在线状态走", () => {
  assert.equal(deriveHostVitals({ isOnline: true }, [metric()]).uptimeLabel, "已运行");
  assert.equal(deriveHostVitals({ isOnline: false }, [metric()]).uptimeLabel, "最后运行");
});

test("完全没有 metrics 时不抛错，全部给「不知道」", () => {
  const v = deriveHostVitals({ isOnline: true }, null);
  assert.equal(v.cpuPercent, null);
  assert.equal(v.speedIn, null);
  assert.equal(v.uptimeText, "—");
  assert.equal(v.lastReportedText, "");
});
