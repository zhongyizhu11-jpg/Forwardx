import assert from "node:assert/strict";
import test from "node:test";

import { chartCeiling, logTicks, normalizeValue, withAlpha } from "./mapCharts";

test("纵轴上限：留 15% 的头，全 0 给 1，固定上限优先", () => {
  assert.equal(chartCeiling([10, null, 40]), 46);
  assert.equal(chartCeiling([0, 0]), 1);
  assert.equal(chartCeiling([], 100), 100);
});

test("对数刻度只画不超过上限的那些", () => {
  assert.deepEqual(logTicks(5), [10]);
  assert.deepEqual(logTicks(150), [10, 100]);
  assert.deepEqual(logTicks(2000), [10, 100, 1000]);
});

test("值映射：线性和对数都夹在 0–1", () => {
  assert.equal(normalizeValue(50, 100, false), 0.5);
  assert.equal(normalizeValue(500, 100, false), 1);
  assert.equal(normalizeValue(10, 100, true), 0.5);
  assert.equal(normalizeValue(0, 100, true), 0);
});

test("颜色透明度：hex 和 rgb 都能加 alpha，别的原样返回", () => {
  assert.equal(withAlpha("#06B6D4", 0.5), "rgba(6,182,212,0.5)");
  assert.equal(withAlpha("rgb(1, 2, 3)", 0.2), "rgba(1,2,3,0.2)");
  assert.equal(withAlpha("oklch(0.7 0.1 200)", 0.2), "oklch(0.7 0.1 200)");
});
