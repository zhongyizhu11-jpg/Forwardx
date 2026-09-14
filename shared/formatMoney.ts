import { MILLI_CENTS_PER_YUAN } from "./trafficBillingPrice";

/**
 * 金额 → 给人看的字符串。全站唯一一份。
 *
 * 之前有 **8 份各自定义**（7 个 `money` + 用户管理里的 `formatCurrencyCny`），
 * 实现大同小异但不完全一致 —— 有的写 `Number(cents) || 0`，有的直接 `cents || 0`，
 * 有的把币种写死成 CNY。钱这件事上，「大同小异」本身就是风险：读到的人没法确定
 * 两个页面上的同一笔钱是不是按同一套规则显示的。
 */
export function formatMoneyCents(cents?: number | string | null, currency = "CNY"): string {
  const value = Number(cents);
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency })
    .format((Number.isFinite(value) ? value : 0) / 100);
}

/**
 * 毫分计价的那一路（按量计费的单价可以低到 0.003 元/GB）。
 *
 * 小数位是动态的：不足一分的单价固定两位就成了「¥0.00」—— 一个明明在收钱的价钱
 * 显示成免费。所以小于 0.01 时给三位。
 */
export function formatMoneyMilliCents(milliCents?: number | string | null, currency = "CNY"): string {
  const raw = Number(milliCents);
  const yuan = (Number.isFinite(raw) ? raw : 0) / MILLI_CENTS_PER_YUAN;
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits: yuan > 0 && yuan < 0.01 ? 3 : 2,
    maximumFractionDigits: 3,
  }).format(yuan);
}
