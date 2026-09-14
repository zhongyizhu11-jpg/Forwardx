import assert from "node:assert/strict";
import test from "node:test";
import { pickTabValue } from "./urlTab";

const values = ["plans", "billing"] as const;

/**
 * 这一条是这个函数存在的理由。
 *
 * 原来的实现从 wouter 的 `useLocation()` 里 split("?") —— 那个值只有路径，
 * 于是 `?tab=billing` 一直被忽略，默默回落到默认 tab。没有任何东西会报错：
 * 一条跳转链接看起来正常，只是落在了错的地方。
 */
test("地址栏里的 tab 说了算", () => {
  assert.equal(pickTabValue("?tab=billing", null, values, "plans"), "billing");
  assert.equal(pickTabValue("tab=billing", null, values, "plans"), "billing", "不带问号也认");
  assert.equal(pickTabValue("/plans?tab=billing", null, values, "plans"), "billing", "整条地址也认");
});

test("地址栏压过上次存的 —— 别人刚发来的链接比你上次停在哪要新", () => {
  assert.equal(pickTabValue("?tab=billing", "plans", values, "plans"), "billing");
  assert.equal(pickTabValue("?tab=plans", "billing", values, "plans"), "plans");
});

test("地址栏没说就用上次存的", () => {
  assert.equal(pickTabValue("", "billing", values, "plans"), "billing");
  assert.equal(pickTabValue("?other=1", "billing", values, "plans"), "billing");
});

test("两边都没有才用默认", () => {
  assert.equal(pickTabValue("", null, values, "plans"), "plans");
  assert.equal(pickTabValue("", undefined, values, "plans"), "plans");
});

/** 认不出来的值一律当没说，不能把一个不存在的 tab 名交出去。 */
test("不在清单里的值一律丢掉", () => {
  assert.equal(pickTabValue("?tab=nonsense", null, values, "plans"), "plans");
  assert.equal(pickTabValue("?tab=nonsense", "billing", values, "plans"), "billing", "地址栏是脏的就退回存的那个");
  assert.equal(pickTabValue("", "已经删掉的tab", values, "plans"), "plans");
});

test("queryKey 可以换，别的键不干扰", () => {
  assert.equal(pickTabValue("?view=billing", null, values, "plans", "view"), "billing");
  assert.equal(pickTabValue("?tab=billing", null, values, "plans", "view"), "plans");
});
