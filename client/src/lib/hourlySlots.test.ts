import assert from "node:assert/strict";
import test from "node:test";
import { hourlySlots } from "./hourlySlots";

const H = 60 * 60 * 1000;

test("过去 24 个整点小时，正在走的这个小时并进最后一格，更早的丢掉", () => {
  const now = Date.UTC(2026, 8, 27, 8, 30);
  const rows = [
    { at: now - 25 * H, v: 999 },      // 太早，丢掉
    { at: now - 24 * H + 1, v: 1 },    // 第一格（08:00 那一格的前 24 小时 = 昨天 08:00）
    { at: now - H, v: 2 },             // 上一小时（07:00）
    { at: now - 10 * 60 * 1000, v: 3 }, // 这个小时（08:00）
    { at: now, v: 4 },                 // 也是这个小时
  ];
  const slots = hourlySlots(rows, (row) => ({ at: row.at, value: row.v }), 24, now);
  assert.equal(slots.length, 24);
  assert.equal(slots[0], 1);
  // 07:00 那一格是第 23 格（过去 24 个整点里的最后一个），08:00 正在走的这个小时并进去
  assert.equal(slots[22], 0);
  assert.equal(slots[23], 9);
  assert.equal(slots.reduce((a, b) => a + b, 0), 10);
});

test("没有数据时是一排 0，坏时间戳和 NaN 不算", () => {
  assert.deepEqual(hourlySlots(null, () => ({ at: 0, value: 1 }), 3), [0, 0, 0]);
  const slots = hourlySlots([{ at: "not a date", v: 5 }, { at: Date.now(), v: Number.NaN }], (row) => ({ at: row.at, value: row.v }), 4);
  assert.deepEqual(slots, [0, 0, 0, 0]);
});
