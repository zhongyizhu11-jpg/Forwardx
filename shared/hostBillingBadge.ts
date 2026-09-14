import { formatTrafficPricePerGb } from "./trafficBillingPrice";

/**
 * 主机卡片上那行「计费」的措辞。
 *
 * 这一行回答的是「这台机器上的转发，扣的是钱还是套餐流量」。答案不在主机上：
 * 计费配置挂在**转发组 / 隧道**上（主机那一档只剩历史配置，界面里已经禁用新建），
 * 所以服务端是顺着这台机器上的转发一条条问出来的，给到这里的就是「N 条里有 M 条
 * 在按量计费」。
 *
 * 抽出来单独测，是因为第一版把「没查到主机级配置」直接当成了「走套餐流量」——
 * 一句关于钱的结论说反了，界面上看不出来。
 */
export type HostTrafficBillingSummary = {
  /** 这台机器上按量计费的转发条数。 */
  billedRules?: unknown;
  /** 这台机器上还在跑的转发总条数。 */
  totalRules?: unknown;
  /** 单价（毫分/GB）。0 = 不给看（非管理员），-1 = 这台上不止一种单价。 */
  pricePerGbMilliCents?: unknown;
  /** 这台机器自己配了「整台兜底价」，并且还开着。 */
  hostDefault?: unknown;
};

export type HostBillingBadge = {
  /** true 就是「有钱在扣」，界面上要标显眼。 */
  metered: boolean;
  label: string;
  title: string;
};

const QUOTA_BADGE: HostBillingBadge = {
  metered: false,
  label: "走套餐流量",
  title: "这台机器上的转发不扣余额，只记进用户自己的套餐流量额度",
};

export function hostBillingBadge(summary: HostTrafficBillingSummary | null | undefined): HostBillingBadge {
  const billed = Math.max(0, Math.trunc(Number(summary?.billedRules) || 0));
  if (!summary || billed <= 0) return QUOTA_BADGE;
  const total = Math.max(billed, Math.trunc(Number(summary?.totalRules) || 0));

  const rawPrice = Number(summary?.pricePerGbMilliCents);
  // -1 是服务端给的暗号：这台机器上的转发挂在不同资源上、单价不一样。
  // 不编一个平均值出来，只说在计费，具体价钱去转发那边看。
  const mixedPrice = rawPrice < 0;
  const priceText = mixedPrice ? "" : formatTrafficPricePerGb(rawPrice);
  const priceSuffix = priceText ? ` · ${priceText}` : "";

  const partial = billed < total;
  const label = partial
    ? `${billed}/${total} 条按量计费${priceSuffix}`
    : `按量计费${priceSuffix}`;

  const hostDefault = !!summary?.hostDefault;
  const title = [
    partial
      ? `这台机器上 ${total} 条转发里有 ${billed} 条按 GB 扣用户余额，其余的记进用户自己的套餐流量额度`
      : "这台机器上的转发按 GB 扣用户余额，不记进用户的套餐流量额度",
    hostDefault
      // 兜底价管着的时候要说清它是**最后一档**：转发组 / 隧道上单独配过价的转发
      // 走它们自己的价，不是整台一个价。不点破的话，人改了兜底价却发现某几条
      // 的账没变，只会以为面板算错了。
      ? "这台机器配了整台兜底价：转发组 / 隧道上单独配过价的转发走它们自己的价，其余的按这台的价"
      : "计费配置挂在转发所属的转发组 / 隧道上，不在主机上",
    mixedPrice ? "这台机器上不止一种单价，具体价钱看各条转发" : "",
    "余额扣完会自动停掉该用户名下的转发",
  ].filter(Boolean).join("\n");

  return { metered: true, label, title };
}
