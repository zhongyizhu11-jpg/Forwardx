/**
 * 余额流水和订阅来源的中文口径，全站唯一一份。
 *
 * 原来 balanceTypeLabel 有三份（服务端通知一份、账单页一份、钱包页一份），
 * subscriptionSourceLabel 有两份 —— 而且**已经漂了**：同一条 source='payment'
 * 的订阅记录，服务端通知里叫「在线购买」，用户管理页叫「在线支付」；兜底文案
 * 一个是「套餐变更」、一个是「套餐记录」。
 *
 * 一笔钱在两个地方叫两个名字，比叫错更让人不敢信 —— 租户会开始怀疑是不是两笔。
 * 这里以服务端那份为准：通知是推到人手机上的，改它的代价最大。
 */

const BALANCE_TYPE_LABELS: Record<string, string> = {
  admin_recharge: "管理员充值",
  admin_adjust: "管理员修改",
  payment: "在线充值入账",
  purchase: "余额消费",
  redeem: "兑换入账",
  traffic_billing: "流量计费",
  traffic_addon_purchase: "购买附加流量",
};

/** 认不出的类型原样显示，不要吞成一句「余额变动」把信息抹掉。 */
export function balanceTypeLabel(type?: string | null) {
  const key = String(type || "");
  return BALANCE_TYPE_LABELS[key] || key || "余额变动";
}

const SUBSCRIPTION_SOURCE_LABELS: Record<string, string> = {
  admin: "管理员分配",
  payment: "在线购买",
  redeem: "兑换套餐",
  balance: "余额购买",
};

export function subscriptionSourceLabel(source?: string | null) {
  const key = String(source || "");
  return SUBSCRIPTION_SOURCE_LABELS[key] || key || "套餐变更";
}
