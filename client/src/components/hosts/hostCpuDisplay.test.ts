import assert from "node:assert/strict";
import test from "node:test";
import { formatCpuPercent } from "./hostDisplay";

/**
 * Agent 把 CPU 占用四舍五入成整数上报，空闲的转发机常年是 0。在线时写「<1%」
 * 而不是「0%」—— 0% 读起来像没在统计，其实是不到 0.5%。
 */
test("在线且不到 1% 写 <1%，其余照常写整数百分比", () => {
  assert.equal(formatCpuPercent(0, true), "<1%");
  assert.equal(formatCpuPercent("0", true), "<1%");
  assert.equal(formatCpuPercent(0.4, true), "<1%");
  assert.equal(formatCpuPercent(1, true), "1%");
  assert.equal(formatCpuPercent(37.6, true), "38%");
  assert.equal(formatCpuPercent(140, true), "100%");
});

test("离线的机器写它最后上报的数，0 就是 0%", () => {
  assert.equal(formatCpuPercent(0, false), "0%");
  assert.equal(formatCpuPercent(12, false), "12%");
});

test("没有数据写「—」", () => {
  assert.equal(formatCpuPercent(null), "—");
  assert.equal(formatCpuPercent(undefined), "—");
  assert.equal(formatCpuPercent("abc"), "—");
  assert.equal(formatCpuPercent(""), "—");
});
