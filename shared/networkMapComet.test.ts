import assert from "node:assert/strict";
import test from "node:test";

import { advanceCometPhase, buildCometPath, cometPeriodMs, pointAt } from "./networkMapComet";
import { greatCircleArc } from "./networkMapGeometry";

const HK: [number, number] = [114.17, 22.32];
const JP: [number, number] = [139.65, 35.68];
const US: [number, number] = [-118.24, 34.05];

test("路径：两跳首尾相接，共用的那台主机只算一个点，累计长度单调递增", () => {
  const hop1 = greatCircleArc(HK, JP, 10);
  const hop2 = greatCircleArc(JP, US, 10);
  const path = buildCometPath([hop1, hop2]);
  assert.ok(path);
  assert.equal(path!.points.length, 21, "11 + 11 − 1 个重合点");
  assert.equal(path!.cum[path!.cum.length - 1], path!.total);
  for (let i = 1; i < path!.cum.length; i += 1) assert.ok(path!.cum[i] > path!.cum[i - 1]);
  assert.equal(buildCometPath([[HK, HK]]), null, "长度为零的路不成路");
});

test("路上的点：0 在入口，total 在出口，走到一半已经离开入口", () => {
  const hop1 = greatCircleArc(HK, JP, 20);
  const hop2 = greatCircleArc(JP, US, 20);
  const path = buildCometPath([hop1, hop2])!;
  assert.ok(Math.hypot(pointAt(path, 0)[0] - HK[0], pointAt(path, 0)[1] - HK[1]) < 1e-9, "起点在香港");
  assert.deepEqual(pointAt(path, path.total), [hop2[hop2.length - 1][0], hop2[hop2.length - 1][1]]);
  assert.ok(pointAt(path, path.total / 2)[0] > HK[0], "一半时已经离开香港");
});

test("相位：一趟走完回绕", () => {
  let phase = 0;
  phase = advanceCometPhase(phase, 500, 2000);
  assert.ok(Math.abs(phase - 0.25) < 1e-9);
  phase = advanceCometPhase(phase, 1600, 2000);
  assert.ok(Math.abs(phase - 0.05) < 1e-9, `回绕 (${phase})`);
  assert.equal(advanceCometPhase(0.3, 100, 0), 0.3, "周期为零不动");
});

test("一趟多久：按屏幕长度走，短线和长线都夹在上下限之间", () => {
  assert.equal(cometPeriodMs(10), 1400);
  assert.equal(cometPeriodMs(1e6), 6000);
  const mid = cometPeriodMs(300);
  assert.ok(mid > 1400 && mid < 6000, `${mid}`);
  assert.equal(cometPeriodMs(Number.NaN), 1400);
});
