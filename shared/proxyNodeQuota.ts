/**
 * 落地机的套餐规格与用量：带宽 / 总流量 / 已用流量。
 *
 * 三个数的来源不一样，这一点决定了界面该怎么说话：
 *
 * - **带宽**、**总流量**：你买的套餐是什么样，面板无从得知，只能手填。
 * - **已用流量**：面板自己累加。但它只数得到**经过面板转发规则**的量 ——
 *   订阅里的「直连」条目是客户端直接连落地机的，中转机根本不在路径上；
 *   这台机器上跑的别的服务同理。所以这个数只会**小于等于**机房的账单口径，
 *   而不会大于。需要对齐机房数字时用手工校准。
 *
 * 这件事必须在界面上说清楚。一个看起来精确、实际偏小的用量数字，会让人在
 * 快超额的时候以为还很宽裕 —— 那比不显示更糟。
 */

export const PROXY_NODE_TRAFFIC_WARN_PERCENT = 80;

/**
 * 多大的流量才写成 T。
 *
 * 定在 1T：`1T` 比 `1000G` 短，节点行上那一栏本来就窄。想让 1000G 的套餐照原样
 * 显示成「1000G」（跟机房卖的写法一致），把这里改成 `2e12` 即可 ——
 * 只有这一个地方要改，测试里也只有几条断言跟着动。
 */
export const QUOTA_TERABYTE_THRESHOLD = 1e12;

export type ProxyNodeQuota = {
  /** 上行带宽 Mbps，0 表示没填。 */
  bandwidthMbps: number;
  /** 套餐总流量（字节），0 表示不限或没填。 */
  trafficLimit: number;
  /** 已用流量（字节），面板累计。 */
  trafficUsed: number;
};

export type ProxyNodeQuotaState = "none" | "normal" | "warn" | "exceeded";

/** 带宽写成 500M / 2.5G 这种机房口径的写法，0 显示成 —。 */
export function formatBandwidthMbps(mbps: number): string {
  const value = Number(mbps);
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value < 1000) return `${value}M`;
  const gbps = value / 1000;
  // 2.5G 要保留一位，10G 不要写成 10.0G。
  return `${Number.isInteger(gbps) ? gbps : Number(gbps.toFixed(1))}G`;
}

/**
 * 流量写成 1000G / 367G 这种机房口径的写法。
 *
 * 刻意用 1000 进制而不是 1024：机房卖的「1000G」是按 1000 算的，
 * 按 1024 换算会显示成 931G，跟你买的套餐对不上号，看着像面板算错了。
 */
export function formatQuotaBytes(bytes: number): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0";
  /**
   * 不到 1M 的显示成「<1M」而不是四舍五入成「1M」。
   * 套餐是按 G 卖的，这个量级本来就等于没用；写成 1M 会让人以为真跑了 1MB。
   */
  if (value < 1e6) return "<1M";
  const units = [
    { limit: QUOTA_TERABYTE_THRESHOLD, suffix: "T", scale: 1e12 },
    { limit: 1e9, suffix: "G", scale: 1e9 },
    { limit: 1e6, suffix: "M", scale: 1e6 },
  ];
  for (const unit of units) {
    if (value >= unit.limit) {
      const scaled = value / unit.scale;
      // 大于 100 就不要小数了：367.4G 这种精度没有意义。
      const text = scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1));
      return `${text}${unit.suffix}`;
    }
  }
  return `${Math.round(value / 1e6)}M`;
}

/** 已用占总量的百分比。没设总量时返回 0 —— 没有分母就没有百分比。 */
export function proxyNodeQuotaPercent(quota: ProxyNodeQuota): number {
  const limit = Number(quota.trafficLimit) || 0;
  if (limit <= 0) return 0;
  const used = Math.max(0, Number(quota.trafficUsed) || 0);
  return Math.min(999, Math.round((used / limit) * 100));
}

export function proxyNodeQuotaState(quota: ProxyNodeQuota): ProxyNodeQuotaState {
  const limit = Number(quota.trafficLimit) || 0;
  if (limit <= 0) return "none";
  /**
   * 按未取整的比例判，不要用显示用的那个百分比：79.9% 取整成 80 就会提前变黄，
   * 用户看到「80%」的警告而实际还没到，反过来也会在 99.5% 时显示 100% 说超额了。
   */
  const ratio = (Math.max(0, Number(quota.trafficUsed) || 0) / limit) * 100;
  if (ratio >= 100) return "exceeded";
  if (ratio >= PROXY_NODE_TRAFFIC_WARN_PERCENT) return "warn";
  return "normal";
}

/**
 * 展开后的一行带标签说明：`带宽 500M · 总流量 1000G · 已用 367G`。
 *
 * 与折起来时的 `500M/1000G/367G` 是同一份数据的两种写法：那个要挤在一行里所以
 * 只能用斜杠，展开之后有地方了，就把三个数各自叫什么写清楚 —— 斜杠那种写法
 * 得先知道顺序才读得懂。没填的那一段直接不出现，而不是占位。
 */
export function formatProxyNodeQuotaDetail(quota: ProxyNodeQuota): string {
  const parts: string[] = [];
  if ((Number(quota.bandwidthMbps) || 0) > 0) parts.push(`带宽 ${formatBandwidthMbps(quota.bandwidthMbps)}`);
  if ((Number(quota.trafficLimit) || 0) > 0) parts.push(`总流量 ${formatQuotaBytes(quota.trafficLimit)}`);
  parts.push(`已用 ${formatQuotaBytes(quota.trafficUsed)}`);
  if ((Number(quota.trafficLimit) || 0) > 0) {
    parts[parts.length - 1] += `（${proxyNodeQuotaPercent(quota)}%）`;
  }
  return parts.join(" · ");
}

/** 这个节点有没有值得展开的套餐信息。三样全空时连图标都不该出现。 */
export function hasProxyNodeQuota(quota: ProxyNodeQuota): boolean {
  return (Number(quota.bandwidthMbps) || 0) > 0
    || (Number(quota.trafficLimit) || 0) > 0
    || (Number(quota.trafficUsed) || 0) > 0;
}

/**
 * 月度重置的边界日收敛到 1-28。
 *
 * 29/30/31 在二月不存在，落在那几天的重置会整月不触发 —— 用户看到的是
 * 「设了自动重置但从来没重置过」，而且查不出原因。
 */
export function normalizeProxyNodeResetDay(value: unknown): number {
  const day = Math.floor(Number(value) || 1);
  return Math.min(28, Math.max(1, day));
}
