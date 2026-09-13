import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultPricingOption,
  findPricingOption,
  normalizePlanPriceTiers,
  planDurationLabel,
  planMonthlyEquivalentCents,
  planPricingOptions,
  renewalPricingOption,
} from "./planPricing";

/**
 * 判错的后果是真金白银：算少了白送服务，算多了是乱扣钱，认错档是「买的年付开出
 * 月付」。所以这一组几乎全在写「什么情况下**不能**按客户以为的那样算」。
 */

test("没配多周期的套餐退回自己那一档 —— 存量数据不用迁移", () => {
  const options = planPricingOptions({ durationDays: 90, priceCents: 3000 }, []);
  assert.equal(options.length, 1);
  assert.deepEqual(
    { d: options[0].durationDays, p: options[0].priceCents, off: options[0].discountPercent },
    { d: 90, p: 3000, off: 0 },
  );
  // 连 durationDays 都没有的脏数据也得给出一档，否则商店上这张卡直接买不了。
  assert.equal(planPricingOptions({}, null)[0].durationDays, 30);
});

test("配了多周期就以那张表为准，按天数升序", () => {
  const options = planPricingOptions({ durationDays: 30, priceCents: 1000 }, [
    { durationDays: 365, priceCents: 9600 },
    { durationDays: 30, priceCents: 1000 },
    { durationDays: 90, priceCents: 2700 },
  ]);
  assert.deepEqual(options.map((item) => item.durationDays), [30, 90, 365]);
});

test("折扣按每天单价算，基准是最短那一档", () => {
  const options = planPricingOptions({}, [
    { durationDays: 30, priceCents: 1000 },   // 33.3 分/天
    { durationDays: 90, priceCents: 2700 },   // 30 分/天 → 省 10%
    { durationDays: 365, priceCents: 9600 },  // 26.3 分/天 → 省 21%
  ]);
  assert.equal(options[0].discountPercent, 0, "基准那档自己不打折");
  assert.equal(options[1].discountPercent, 10);
  assert.equal(options[2].discountPercent, 21);
});

test("长周期反而更贵时不显示折扣 —— 别写一个负数出来", () => {
  const options = planPricingOptions({}, [
    { durationDays: 30, priceCents: 1000 },
    { durationDays: 90, priceCents: 4000 },
  ]);
  assert.equal(options[1].discountPercent, 0);
});

test("免费套餐不谈折扣", () => {
  const options = planPricingOptions({}, [
    { durationDays: 30, priceCents: 0 },
    { durationDays: 365, priceCents: 0 },
  ]);
  assert.equal(options[1].discountPercent, 0);
});

test("默认选总价最低的那一档，不是每天最划算的", () => {
  const options = planPricingOptions({}, [
    { durationDays: 30, priceCents: 1000 },
    { durationDays: 365, priceCents: 9600 },
  ]);
  // 年付每天更便宜，但默认选中它等于「点错一下就是一年的钱」。
  assert.equal(defaultPricingOption(options)?.durationDays, 30);
  assert.equal(defaultPricingOption([]), null);
});

test("同价时默认给周期长的 —— 一样的钱多给几天", () => {
  const options = planPricingOptions({}, [
    { durationDays: 30, priceCents: 1000 },
    { durationDays: 90, priceCents: 1000 },
  ]);
  assert.equal(defaultPricingOption(options)?.durationDays, 90);
});

test("洗表：非法行丢掉，重复周期只留第一条", () => {
  const rows = normalizePlanPriceTiers([
    { durationDays: 30, priceCents: 1000 },
    { durationDays: 30, priceCents: 9999 },  // 重复：留上面那条
    { durationDays: 0, priceCents: 500 },    // 永久不是一个可买周期
    { durationDays: -5, priceCents: 500 },
    { durationDays: 90, priceCents: -1 },    // 负价
    { durationDays: 365, priceCents: 0 },    // 0 元是合法的（送的、内部用的）
  ]);
  assert.deepEqual(rows, [
    { durationDays: 30, priceCents: 1000 },
    { durationDays: 365, priceCents: 0 },
  ]);
});

test("认不出的档位一律拒掉，不能拿默认档顶上", () => {
  const options = planPricingOptions({}, [
    { durationDays: 30, priceCents: 1000 },
    { durationDays: 365, priceCents: 9600 },
  ]);
  // 下单和收款之间隔着一次跳转，管理员可能已经把那一档删了。
  // 顶上默认档就成了「我买的是年付，开出来是月付」。
  assert.equal(findPricingOption(options, 180), null);
  assert.equal(findPricingOption(options, 0), null);
  assert.equal(findPricingOption(options, "abc"), null);
  assert.equal(findPricingOption(options, 365)?.priceCents, 9600);
});

test("续期优先续上次买的那一档", () => {
  const options = planPricingOptions({}, [
    { durationDays: 30, priceCents: 1000 },
    { durationDays: 365, priceCents: 9600 },
  ]);
  const same = renewalPricingOption(options, 365);
  assert.equal(same.option?.durationDays, 365);
  assert.equal(same.fellBack, false);

  // 那一档被下掉了：退回默认档，并且要能看出发生了回退（调用方要写日志）。
  const gone = renewalPricingOption(options, 180);
  assert.equal(gone.option?.durationDays, 30);
  assert.equal(gone.fellBack, true);
});

test("周期名称：预设有中文名，其他按天显示", () => {
  assert.equal(planDurationLabel(90), "三个月");
  assert.equal(planDurationLabel(45), "45 天");
  assert.equal(planDurationLabel(0), "永久");
});

test("折成每月多少钱：商店和管理端用同一个换算", () => {
  const options = planPricingOptions({}, [
    { durationDays: 30, priceCents: 1000 },
    { durationDays: 365, priceCents: 9600 },
  ]);
  assert.equal(planMonthlyEquivalentCents(options[0]), 1000, "月付那档折下来就是它自己");
  // 年付 96 元 ≈ 每月 7.89 元。客户比价时心里的单位是月，不是天也不是总价。
  assert.equal(planMonthlyEquivalentCents(options[1]), 789);
  assert.equal(planMonthlyEquivalentCents({ perDayCents: 0 }), 0);
});
