import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeHostAlertThreshold,
  normalizeHostRenewalDays,
  planHostRenewalReminder,
  planHostTrafficReminder,
} from "./hostReminder";

/**
 * 判错的后果是两种：漏报（客户先于商家发现机器停了）和天天骚扰。
 */

test("流量：到了阈值才提醒", () => {
  const host = { trafficLimit: 1000, trafficAlertThresholdPercent: 20 };
  assert.equal(planHostTrafficReminder(host, 700).due, false, "还剩 30%，不吵");
  assert.equal(planHostTrafficReminder(host, 800).due, true, "剩 20%，到线了");
  assert.equal(planHostTrafficReminder(host, 1200).due, true, "已经超了，当然要说");
  assert.equal(planHostTrafficReminder(host, 800).leftPercent, 20);
});

test("流量：没填总量就不提醒 —— 算不出「还剩多少」", () => {
  // 硬算会得到 100% 或者负数，两种都是假话。
  assert.equal(planHostTrafficReminder({ trafficLimit: 0 }, 999).due, false);
  assert.equal(planHostTrafficReminder({}, 999).due, false);
});

test("阈值离谱时退回默认值，不要 0 也不要 100", () => {
  // 0 = 永不提醒，100 = 天天提醒，两个都让这个功能失去意义。
  assert.equal(normalizeHostAlertThreshold(0), 20);
  assert.equal(normalizeHostAlertThreshold(-5), 20);
  assert.equal(normalizeHostAlertThreshold(999), 99);
  assert.equal(normalizeHostAlertThreshold("abc"), 20);
  assert.equal(normalizeHostAlertThreshold(35), 35);
});

test("续费：进了提醒窗口才说", () => {
  const now = Date.UTC(2026, 0, 10);
  const day = 24 * 3600 * 1000;
  const host = (offsetDays: number) => ({ stoppedAt: new Date(now + offsetDays * day), renewalReminderDays: 3 });

  assert.equal(planHostRenewalReminder(host(5), now).due, false, "还有 5 天，早着");
  assert.equal(planHostRenewalReminder(host(3), now).due, true);
  assert.equal(planHostRenewalReminder(host(0), now).due, true, "今天就停机，必须说");
  // 已经过了停机日就别再念了 —— 那时该做的是去续。
  assert.equal(planHostRenewalReminder(host(-2), now).due, false);
  assert.equal(planHostRenewalReminder(host(-2), now).daysLeft, -2);
});

test("续费：没填停机日期就没有这回事", () => {
  assert.equal(planHostRenewalReminder({}).due, false);
  assert.equal(planHostRenewalReminder({ stoppedAt: "不是日期" }).due, false);
});

test("提前天数离谱时退回默认值", () => {
  assert.equal(normalizeHostRenewalDays(0), 3);
  assert.equal(normalizeHostRenewalDays(9999), 365);
  assert.equal(normalizeHostRenewalDays(7), 7);
});
