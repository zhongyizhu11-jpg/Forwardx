import assert from "node:assert/strict";
import test from "node:test";

import {
  formatTrafficPricePerGb,
  MIN_PRICE_PER_GB_MILLI_CENTS,
  milliCentsFromYuan,
  priceInputFromMilliCents,
  yuanFromMilliCents,
} from "./trafficBillingPrice";

/**
 * 单价换算错了不会报错，只会静静地把价钱显示成十倍。
 * 我第一版写成了 `/ 100 / 100`（那是「分→元」做了两次），0.5 元/GB 显示成 5 元 ——
 * 没有任何东西会拦这种错，只有把它摆成能被断言的函数才拦得住。
 */
test("毫分换算成元：1 元 = 100000 毫分", () => {
  assert.equal(yuanFromMilliCents(100_000), 1);
  assert.equal(yuanFromMilliCents(50_000), 0.5);
  assert.equal(yuanFromMilliCents(1_000), 0.01, "1000 毫分就是一分钱");
  assert.equal(yuanFromMilliCents(300), 0.003, "不足一分的单价也得算得出来");
});

test("没设单价就不显示，别让人当成免费", () => {
  assert.equal(formatTrafficPricePerGb(0), "");
  assert.equal(formatTrafficPricePerGb(null), "");
  assert.equal(formatTrafficPricePerGb(undefined), "");
  assert.equal(formatTrafficPricePerGb(-5), "");
  assert.equal(formatTrafficPricePerGb("abc"), "");
});

test("显示成人看得懂的价钱", () => {
  assert.equal(formatTrafficPricePerGb(50_000), "¥0.5/GB");
  assert.equal(formatTrafficPricePerGb(100_000), "¥1/GB", "整数不拖小数点");
  assert.equal(formatTrafficPricePerGb(250_000), "¥2.5/GB");
  assert.equal(formatTrafficPricePerGb(300), "¥0.003/GB", "便宜的单价不能被截成 0");
});

test("元填进去、毫分存下来，来回一趟不走样", () => {
  for (const yuan of [0.001, 0.003, 0.5, 1, 2.8, 12.345]) {
    const milliCents = milliCentsFromYuan(yuan);
    assert.equal(yuanFromMilliCents(milliCents), yuan, String(yuan));
    assert.equal(priceInputFromMilliCents(milliCents), String(yuan), String(yuan));
  }
});

test("浮点乘法不能把 0.003 变成 300.00000000000006 毫分", () => {
  assert.equal(milliCentsFromYuan(0.003), 300);
  assert.equal(Number.isInteger(milliCentsFromYuan(2.8)), true);
});

test("没填价和脏值都归零，不硬编一个价出来", () => {
  for (const bad of ["", null, undefined, "abc", -1, 0, NaN]) {
    assert.equal(milliCentsFromYuan(bad), 0, String(bad));
    assert.equal(priceInputFromMilliCents(bad), "", String(bad));
  }
});

/**
 * 0 在这里不是「免费」而是「没设价」：一条价钱为 0 的计费配置会把资源标成在计费、
 * 却一分不扣 —— 账对不上，而且看界面完全看不出原因。
 */
test("最低单价是 0.001 元/GB", () => {
  assert.equal(MIN_PRICE_PER_GB_MILLI_CENTS, milliCentsFromYuan(0.001));
});
