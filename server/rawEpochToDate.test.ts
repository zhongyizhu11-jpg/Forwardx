import assert from "node:assert/strict";
import test from "node:test";

import { rawEpochToDate } from "./dbRuntime";

/**
 * 原生 SQL 查出来的时间列：三种数据库都存成秒，queryRaw 拿到的是原始值（PostgreSQL 的 int
 * 可能是字符串）。前端直接 new Date(秒) 会当成毫秒 —— 诊断对话框里「上次诊断」曾显示成
 * 1970 年 1 月 21 日。
 */
test("秒、字符串秒、毫秒、Date、ISO 字符串都换成同一个时刻", () => {
  const seconds = 1790208331;
  const expected = seconds * 1000;
  assert.equal(rawEpochToDate(seconds)?.getTime(), expected);
  assert.equal(rawEpochToDate(String(seconds))?.getTime(), expected, "PostgreSQL 的 int 可能是字符串");
  assert.equal(rawEpochToDate(expected)?.getTime(), expected, "已经是毫秒的原样用");
  assert.equal(rawEpochToDate(new Date(expected))?.getTime(), expected);
  assert.equal(rawEpochToDate(new Date(expected).toISOString())?.getTime(), expected);
  // 反向对照：直接 new Date(秒) 正是那个 1970 年的 bug
  assert.equal(new Date(seconds).getUTCFullYear(), 1970);
  assert.equal(rawEpochToDate(seconds)?.getUTCFullYear(), 2026);
});

test("空值和坏值不编一个时间出来", () => {
  for (const value of [null, undefined, "", 0, -5, "not a date", new Date("nope")]) {
    assert.equal(rawEpochToDate(value), null, String(value));
  }
});
