import assert from "node:assert/strict";
import test from "node:test";

import {
  parseEasyPayOrderQuery,
  parseStripeSessionQuery,
  shouldQueryPendingOrder,
} from "./paymentReconcile";

/**
 * 判错的后果是两种事故：认成已付 = 白送服务；认成未付 = 收了钱不发货。
 * 所以这一组用例几乎全在写「什么情况下**不能**算已付」。
 */

test("易支付：code 是查询成不成功，status 才是付没付", () => {
  // 把 code=1 当成付款成功是最容易犯的错 —— 那等于每查一次就白送一次。
  assert.equal(parseEasyPayOrderQuery({ code: 1, status: 0 }).paid, false);
  assert.equal(parseEasyPayOrderQuery({ code: 1, status: 1 }).paid, true);
  assert.equal(parseEasyPayOrderQuery({ code: 1, status: "1", trade_no: "T9" }).tradeNo, "T9");
});

test("易支付：查询本身失败，一律不算已付", () => {
  assert.equal(parseEasyPayOrderQuery({ code: 0, status: 1 }).paid, false);
  assert.equal(parseEasyPayOrderQuery({ msg: "签名错误" }).paid, false);
  assert.equal(parseEasyPayOrderQuery(null).paid, false);
  assert.equal(parseEasyPayOrderQuery("boom").paid, false);
});

test("易支付：查无此单就别再问了", () => {
  const result = parseEasyPayOrderQuery({ code: -1, msg: "订单不存在" });
  assert.equal(result.paid, false);
  assert.equal(result.closed, true);
  // 普通失败不该被当成「关掉了」—— 那会让一次网络抖动变成永久放弃。
  assert.equal(parseEasyPayOrderQuery({ code: 0 }).closed, false);
});

test("Stripe：看 payment_status，不看 status", () => {
  // status=complete 但 payment_status=unpaid 是真实存在的组合（异步付款方式），
  // 照 status 判就会发货了却没收到钱。
  assert.equal(parseStripeSessionQuery({ status: "complete", payment_status: "unpaid" }).paid, false);
  assert.equal(parseStripeSessionQuery({ status: "complete", payment_status: "paid" }).paid, true);
  assert.equal(parseStripeSessionQuery({ payment_status: "no_payment_required" }).paid, true);
  assert.equal(parseStripeSessionQuery({ status: "expired", payment_status: "unpaid" }).closed, true);
});

test("Stripe：payment_intent 是字符串或对象都要取得到交易号", () => {
  assert.equal(parseStripeSessionQuery({ payment_status: "paid", payment_intent: "pi_1" }).tradeNo, "pi_1");
  assert.equal(parseStripeSessionQuery({ payment_status: "paid", payment_intent: { id: "pi_2" } }).tradeNo, "pi_2");
  assert.equal(parseStripeSessionQuery({ payment_status: "paid", id: "cs_3" }).tradeNo, "cs_3");
});

test("太新的单不问，过期的单也不问", () => {
  const now = Date.now();
  const fresh = { createdAt: new Date(now - 30 * 1000), expiresAt: new Date(now + 600 * 1000) };
  const ripe = { createdAt: new Date(now - 5 * 60 * 1000), expiresAt: new Date(now + 600 * 1000) };
  const dead = { createdAt: new Date(now - 5 * 60 * 1000), expiresAt: new Date(now - 60 * 1000) };

  // 刚下单的人可能还停在收银台，回调本来也就几秒的事。
  assert.equal(shouldQueryPendingOrder(fresh, now), false);
  assert.equal(shouldQueryPendingOrder(ripe, now), true);
  // 过期了该做的是关单，不是继续问。
  assert.equal(shouldQueryPendingOrder(dead, now), false);
  // 没有有效期的单（有些网关不给）照问不误。
  assert.equal(shouldQueryPendingOrder({ createdAt: new Date(now - 5 * 60 * 1000) }, now), true);
  assert.equal(shouldQueryPendingOrder({}, now), false);
});
