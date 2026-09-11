/**
 * 分享给别人的节点，进到对方订阅里之前要改两处。
 *
 * 放在 shared 是为了能脱开数据库单测，也为了面板预览和服务端渲染用同一份逻辑 ——
 * 订阅这一摊里「预览所见即客户端所得」是硬要求。
 */

/** 订阅组装只关心这几个字段，其余原样带过去。 */
export type ShareableProxyNodeRow = {
  id: number;
  includeDirect?: unknown;
  frontProxyId?: unknown;
  [key: string]: unknown;
};

/**
 * 把一行节点改写成「分享给别人的那一份」。
 *
 * includeDirect 强制打开：分享的意思就是让对方连这个落地，而对方名下没有任何
 * 绑到它的转发，直连是唯一的出口。不开的话对方的订阅里什么都不会多出来，
 * 而界面上却显示已经分享了。
 *
 * frontProxyId 清零：它指向节点主人自己的另一行，对方订阅里没有那一行。
 * 组装时虽然会因为「前置没进订阅就不挂引用」而兜住，但 id 是全表自增的，
 * 万一对方名下恰好有一行同号节点，引用就会落到一个毫不相干的节点上 ——
 * 那是把自己的链路悄悄接到别人的机器上，必须在这里断掉而不是指望下游兜底。
 */
export function shareProxyNodeRow<T extends ShareableProxyNodeRow>(row: T): T {
  return { ...row, includeDirect: true, frontProxyId: 0 };
}

/**
 * 收方能看到的字段。
 *
 * 套餐规格与用量是节点主人的账单口径，不该随着节点一起送出去 —— 对方只需要
 * 连得上，不需要知道这台机器买的是多少 G。
 */
export function redactSharedProxyNodeRow<T extends ShareableProxyNodeRow>(row: T): T {
  return {
    ...row,
    bandwidthMbps: 0,
    trafficLimit: 0,
    trafficUsed: 0,
    trafficAutoReset: false,
    remark: null,
  };
}
