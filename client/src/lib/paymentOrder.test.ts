import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { paymentPollOutcome, pendingPaymentOrderFrom } from "./paymentOrder";

test("QR-only orders (WeChat Native / Alipay precreate) still need the dialog", () => {
  const pending = pendingPaymentOrderFrom({ outTradeNo: "T1", qrCode: "weixin://wxpay/bizpayurl?pr=abc", payUrl: null, subject: "充值" });
  assert.deepEqual(pending, { outTradeNo: "T1", qrCode: "weixin://wxpay/bizpayurl?pr=abc", payUrl: null, subject: "充值" });
});

test("redirect orders keep the pay URL for a clickable fallback", () => {
  const pending = pendingPaymentOrderFrom({ outTradeNo: "T2", payUrl: "https://pay.example.com/x" });
  assert.equal(pending?.payUrl, "https://pay.example.com/x");
  assert.equal(pending?.qrCode, null);
  assert.equal(pending?.subject, "");
});

test("orders without anything to act on do not open the dialog", () => {
  assert.equal(pendingPaymentOrderFrom(null), null);
  assert.equal(pendingPaymentOrderFrom({ outTradeNo: "T3", payUrl: "", qrCode: " " }), null);
  assert.equal(pendingPaymentOrderFrom({ payUrl: "https://pay.example.com/x" }), null);
});

test("poll outcome maps order statuses", () => {
  for (const status of ["completed", "paid", "processing"]) assert.equal(paymentPollOutcome(status), "paid");
  for (const status of ["expired", "failed", "cancelled"]) assert.equal(paymentPollOutcome(status), "closed");
  for (const status of ["pending", undefined, null, ""]) assert.equal(paymentPollOutcome(status), "pending");
});

test("wallet recharge, renewals and the store all use the shared payment dialog", () => {
  for (const page of ["Store.tsx", "Wallet.tsx", "Subscriptions.tsx"]) {
    const source = fs.readFileSync(new URL(`../pages/${page}`, import.meta.url), "utf8");
    assert.match(source, /usePaymentOrderDialog\(/, page);
    assert.match(source, /paymentDialog\.launch\(order\)/, page);
    assert.match(source, /\{paymentDialog\.dialog\}/, page);
    assert.doesNotMatch(source, /window\.open\(order\.payUrl/, page);
  }
});
