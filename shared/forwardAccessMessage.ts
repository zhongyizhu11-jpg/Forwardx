/**
 * 拨完「转发」开关之后该跟人说什么。
 *
 * 原来这句话是照着**请求值**编的：点了开启就弹「用户转发已开启」，不看服务端到底
 * 落成了什么。而用户超额时生效值仍然是关 —— 于是 toast 说开了，开关还是灰的，
 * 刷新一次原样。管理员以为开好了，租户那边一条转发都跑不起来，最后来问你。
 *
 * 抽出来单独测，是因为这类错不会报异常：界面看着一切正常，只是说的话不是真的。
 */
export type ForwardAccessPauseReason = "manual" | "traffic_billing_balance" | "traffic_limit" | "expired" | null;

/** 挡住的原因 + 下一步做什么。只说原因不说出路，人还是不知道该干嘛。 */
export function forwardAccessBlockedReasonText(reason: ForwardAccessPauseReason | string | null | undefined): string {
  switch (reason) {
    case "traffic_limit":
      return "流量已超额，先重置流量统计或调高额度";
    case "expired":
      return "账户已到期，先续期";
    case "traffic_billing_balance":
      return "按量计费余额不足，先充值";
    default:
      // 拿不到原因时不硬编一个 —— 编错了比不说更难排查。
      return "面板随即又把它关上了，检查这个账户的额度、有效期和余额";
  }
}

export type ForwardAccessMessage = { tone: "success" | "warning"; text: string };

export function forwardAccessResultMessage(input: {
  requested: boolean;
  /** 服务端重算之后真正生效的值。拿不到（老服务端）时传 undefined。 */
  effective?: boolean | null;
  reason?: ForwardAccessPauseReason | string | null;
}): ForwardAccessMessage {
  const requested = !!input.requested;
  // 老服务端不回生效值：那就只说做了什么请求，别替它打包票。
  const effective = input.effective === undefined || input.effective === null ? requested : !!input.effective;
  if (effective === requested) {
    return { tone: "success", text: requested ? "用户转发已开启" : "用户转发已关闭" };
  }
  if (requested) {
    return { tone: "warning", text: `没能开启：${forwardAccessBlockedReasonText(input.reason)}` };
  }
  // 请求关却还开着 —— 不该发生，但真发生了要说出来，别报一句「已关闭」。
  return { tone: "warning", text: "关闭没有生效，请刷新后重试" };
}
