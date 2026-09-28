/**
 * 在线支付下单后前端该怎么接着走 —— 商店、账单中心充值、套餐续费三处共用。
 *
 * 网关返回两种东西：
 * - qrCode：微信 Native（weixin://…）、支付宝当面付（precreate）只给一串二维码内容，
 *   不渲染成二维码用户根本付不了；
 * - payUrl：跳转支付（page / wap / Stripe / h5），新标签页打开。可 window.open 发生在请求回来之后，
 *   浏览器常当成弹窗拦掉，所以还得留一个能点的链接兜底。
 */

export type PaymentOrderLike = {
  outTradeNo?: string | null;
  qrCode?: string | null;
  payUrl?: string | null;
  subject?: string | null;
};

export type PendingPaymentOrder = {
  outTradeNo: string;
  qrCode: string | null;
  payUrl: string | null;
  subject: string;
};

/** 下单结果里有需要用户继续操作的东西（二维码或支付链接）才返回，否则 null。 */
export function pendingPaymentOrderFrom(order: PaymentOrderLike | null | undefined): PendingPaymentOrder | null {
  const outTradeNo = String(order?.outTradeNo || "").trim();
  const qrCode = String(order?.qrCode || "").trim() || null;
  const payUrl = String(order?.payUrl || "").trim() || null;
  if (!outTradeNo || (!qrCode && !payUrl)) return null;
  return { outTradeNo, qrCode, payUrl, subject: String(order?.subject || "").trim() };
}

export type PaymentPollOutcome = "paid" | "closed" | "pending";

/** 轮询订单状态时怎么处理：已付（含回调处理中）、已失效，还是继续等。 */
export function paymentPollOutcome(status: string | null | undefined): PaymentPollOutcome {
  if (status === "completed" || status === "paid" || status === "processing") return "paid";
  if (status === "expired" || status === "failed" || status === "cancelled" || status === "closed") return "closed";
  return "pending";
}
