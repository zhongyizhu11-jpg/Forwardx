/**
 * 账单流水那一行金额该用什么颜色，账单页和钱包页原来各存一份。
 *
 * 颜色在这里是**语义**不是装饰：扣钱红、进账绿。两页各写一份的话，同一笔流水
 * 在两个地方可能显示成两种颜色 —— 租户对着钱看颜色判断「这是扣的还是进的」。
 */
export function ledgerTone(item: any) {
  if (item.kind === "balance" && Number(item.amountCents) < 0) return "text-destructive";
  if (item.kind === "balance" && Number(item.amountCents) > 0) return "text-emerald-600";
  if (item.kind === "payment" && (item.status === "paid" || item.status === "completed")) return "text-emerald-600";
  return "";
}
