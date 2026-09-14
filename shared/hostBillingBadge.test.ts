import test from "node:test";
import assert from "node:assert/strict";
import { hostBillingBadge } from "./hostBillingBadge";

test("没有计费配置时说走套餐流量", () => {
  for (const input of [null, undefined, { billedRules: 0, totalRules: 4, pricePerGbMilliCents: 0 }]) {
    const badge = hostBillingBadge(input as any);
    assert.equal(badge.metered, false);
    assert.equal(badge.label, "走套餐流量");
  }
});

test("整台都在计费时带上单价", () => {
  const badge = hostBillingBadge({ billedRules: 3, totalRules: 3, pricePerGbMilliCents: 50_000 });
  assert.equal(badge.metered, true);
  assert.equal(badge.label, "按量计费 · ¥0.5/GB");
  assert.match(badge.title, /扣用户余额/);
});

test("只有一部分转发在计费时说清是几条", () => {
  const badge = hostBillingBadge({ billedRules: 1, totalRules: 4, pricePerGbMilliCents: 100_000 });
  assert.equal(badge.metered, true);
  assert.equal(badge.label, "1/4 条按量计费 · ¥1/GB");
  // 悬停里要说明另外三条去哪了，否则「1/4」看不懂。
  assert.match(badge.title, /其余的记进用户自己的套餐流量额度/);
});

test("非管理员拿到的单价是 0，界面就不报价", () => {
  const badge = hostBillingBadge({ billedRules: 2, totalRules: 2, pricePerGbMilliCents: 0 });
  assert.equal(badge.metered, true);
  assert.equal(badge.label, "按量计费");
  assert.ok(!badge.label.includes("¥"));
});

test("一台机器上有几种单价时不编一个价钱出来", () => {
  const badge = hostBillingBadge({ billedRules: 2, totalRules: 2, pricePerGbMilliCents: -1 });
  assert.equal(badge.metered, true);
  assert.equal(badge.label, "按量计费");
  assert.match(badge.title, /不止一种单价/);
});

test("计费条数多过总条数时不出现 3/2 这种label", () => {
  const badge = hostBillingBadge({ billedRules: 3, totalRules: 2, pricePerGbMilliCents: 0 });
  assert.equal(badge.label, "按量计费");
});
