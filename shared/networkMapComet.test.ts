import assert from "node:assert/strict";
import test from "node:test";

import { COMET_REST, advanceCometPhase, buildCometPath, cometPeriodMs, cometProgress, hopIndexAt, mercator, pointAt, sampleComet } from "./networkMapComet";
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
  assert.equal(path!.hopEnds.length, 2);
  assert.ok(path!.hopEnds[0] > 0 && path!.hopEnds[0] < path!.hopEnds[1]);
  assert.equal(path!.hopEnds[1], path!.total);
  for (let i = 1; i < path!.cum.length; i += 1) assert.ok(path!.cum[i] > path!.cum[i - 1]);
  assert.equal(buildCometPath([[HK, HK]]), null, "长度为零的路不成路");
});

test("采样：t=0 在入口，t=1 在出口，过了第一跳的长度就在第二跳上", () => {
  const hop1 = greatCircleArc(HK, JP, 20);
  const hop2 = greatCircleArc(JP, US, 20);
  const path = buildCometPath([hop1, hop2])!;
  assert.ok(Math.hypot(pointAt(path, 0)[0] - HK[0], pointAt(path, 0)[1] - HK[1]) < 1e-9, "起点在香港");
  assert.deepEqual(pointAt(path, path.total), [hop2[hop2.length - 1][0], hop2[hop2.length - 1][1]]);
  const half = sampleComet(path, 0.5, 0);
  assert.ok(half.head[0] > HK[0], `一半时已经离开香港 (${half.head[0]})`);
  assert.equal(hopIndexAt(path, path.hopEnds[0] - 1e-9), 0);
  assert.equal(hopIndexAt(path, path.hopEnds[0] + 1e-9), 1, "刚过东京就是第二跳");
  const boundary = path.hopEnds[0] / path.total;
  assert.equal(sampleComet(path, boundary - 0.01, 0).hop, 0);
  assert.equal(sampleComet(path, boundary + 0.01, 0).hop, 1);
});

test("尾巴：从头往回截 tailLength，刚出发时从入口开始，尾巴的最后一个点就是头", () => {
  const path = buildCometPath([greatCircleArc(HK, US, 40)])!;
  const early = sampleComet(path, 0.02, path.total * 0.2);
  assert.ok(Math.hypot(early.tail[0][0] - HK[0], early.tail[0][1] - HK[1]) < 1e-9, "刚出发时尾巴从入口开始");
  assert.deepEqual(early.tail[early.tail.length - 1], early.head);
  const mid = sampleComet(path, 0.5, path.total * 0.1);
  assert.ok(mid.tail.length >= 3, "尾巴带上了中间的顶点");
  const tailStart = mercator(mid.tail[0]);
  const head = mercator(mid.head);
  const length = Math.hypot(head.x - tailStart.x, head.y - tailStart.y);
  assert.ok(length > 0 && length <= path.total * 0.1 + 1e-9, `尾巴不比 tailLength 长 (${length})`);
});

test("相位：一趟走完回绕，最后 COMET_REST 那段不显示", () => {
  let phase = 0;
  phase = advanceCometPhase(phase, 500, 2000);
  assert.ok(Math.abs(phase - 0.25) < 1e-9);
  phase = advanceCometPhase(phase, 1600, 2000);
  assert.ok(Math.abs(phase - 0.05) < 1e-9, `回绕 (${phase})`);
  assert.equal(advanceCometPhase(0.3, 100, 0), 0.3, "周期为零不动");
  assert.equal(cometProgress(0), 0);
  assert.ok(Math.abs(cometProgress(1 - COMET_REST)! - 1) < 1e-9, "正好飞到出口");
  assert.equal(cometProgress(1 - COMET_REST / 2), null, "停在出口的那段不画");
  assert.equal(cometProgress(1), 0, "下一趟从头来");
});

test("一趟多久：按屏幕长度走，短线和长线都夹在上下限之间", () => {
  assert.equal(cometPeriodMs(10), 1400);
  assert.equal(cometPeriodMs(1e6), 6000);
  const mid = cometPeriodMs(300);
  assert.ok(mid > 1400 && mid < 6000, `${mid}`);
  assert.equal(cometPeriodMs(Number.NaN), 1400);
});
