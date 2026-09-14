import assert from "node:assert/strict";
import test from "node:test";
import { formatMoneyCents, formatMoneyMilliCents } from "./formatMoney";

test("分转成元", () => {
  assert.equal(formatMoneyCents(0), "¥0.00");
  assert.equal(formatMoneyCents(1999), "¥19.99");
  assert.equal(formatMoneyCents(100000), "¥1,000.00");
});

/** 接口回来的金额经常是字符串；有一份旧实现写的是 `cents || 0`，靠隐式转换蒙对。 */
test("字符串金额也认", () => {
  assert.equal(formatMoneyCents("1999"), "¥19.99");
});

test("脏值按 0 算，不把 NaN 显示成钱", () => {
  for (const bad of [null, undefined, "", "abc", NaN, Infinity]) {
    assert.equal(formatMoneyCents(bad as any), "¥0.00", String(bad));
  }
});

test("负数照实显示 —— 退款和扣费是真实存在的方向", () => {
  assert.equal(formatMoneyCents(-500), "-¥5.00");
});

test("币种可换，默认人民币", () => {
  assert.ok(formatMoneyCents(1999, "USD").includes("19.99"));
});

/**
 * 按量计费的单价能低到 0.003 元/GB。固定两位小数会把它显示成「¥0.00」——
 * 一个正在收钱的价钱看起来像免费，这是关于钱的假话。
 */
test("不足一分的单价要给三位小数，不能显示成 ¥0.00", () => {
  assert.equal(formatMoneyMilliCents(300), "¥0.003");
  assert.notEqual(formatMoneyMilliCents(300), "¥0.00");
  assert.equal(formatMoneyMilliCents(100000), "¥1.00");
  assert.equal(formatMoneyMilliCents(280000), "¥2.80");
});

test("毫分那一路的脏值同样按 0 算", () => {
  assert.equal(formatMoneyMilliCents(null), "¥0.00");
  assert.equal(formatMoneyMilliCents("abc" as any), "¥0.00");
});
