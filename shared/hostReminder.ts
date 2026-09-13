/**
 * 主机的两类提醒：流量快用完了、机器快到期了。
 *
 * 「该不该提醒」和「怎么送出去」原来搅在一起，写死在 Telegram 那条路里 ——
 * 于是没绑 Telegram 的商家一条都收不到：机房流量跑超、机器到期停机，全都没人告诉他。
 * 而这两件事一旦发生，他名下所有转发和落地节点会一起断。
 *
 * 这份文件只回答「该不该提醒、还剩多少」，纯计算；发邮件还是发 Telegram 由调用方决定。
 * 判错的后果是漏报（客户先于商家发现机器停了）或者天天骚扰，所以单独测。
 */

export type HostTrafficReminder = {
  due: boolean;
  /** 还剩百分之几，0-100。总量没填时无意义。 */
  leftPercent: number;
  usedBytes: number;
  limitBytes: number;
  thresholdPercent: number;
};

/** 阈值的合理区间：0 和 100 都会让提醒失去意义（永不发 / 天天发）。 */
export function normalizeHostAlertThreshold(value: unknown, fallback = 20): number {
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(99, Math.max(1, num));
}

/** 提前几天提醒续费。 */
export function normalizeHostRenewalDays(value: unknown, fallback = 3): number {
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(365, Math.max(1, num));
}

/**
 * 这台机器的流量该不该提醒。
 *
 * 没填总量就不提醒 —— 不知道上限时算不出「还剩多少」，硬算会得到 100% 或者负数。
 */
export function planHostTrafficReminder(
  host: { trafficLimit?: unknown; trafficAlertThresholdPercent?: unknown },
  usedBytes: unknown,
): HostTrafficReminder {
  const limitBytes = Math.max(0, Math.floor(Number(host?.trafficLimit) || 0));
  const used = Math.max(0, Math.floor(Number(usedBytes) || 0));
  const thresholdPercent = normalizeHostAlertThreshold(host?.trafficAlertThresholdPercent);
  if (limitBytes <= 0) {
    return { due: false, leftPercent: 100, usedBytes: used, limitBytes: 0, thresholdPercent };
  }
  const leftPercent = Math.max(0, Math.round(((limitBytes - used) / limitBytes) * 100));
  return { due: leftPercent <= thresholdPercent, leftPercent, usedBytes: used, limitBytes, thresholdPercent };
}

export type HostRenewalReminder = {
  due: boolean;
  /** 距停机还有几天；已经过了就是负数。 */
  daysLeft: number;
  stoppedAtMs: number;
};

/**
 * 这台机器的续费该不该提醒。
 *
 * 已经过了停机日就不再提醒：那时该做的是去续，不是继续每天说一遍「还有 -5 天」。
 */
export function planHostRenewalReminder(
  host: { stoppedAt?: unknown; renewalReminderDays?: unknown },
  now = Date.now(),
): HostRenewalReminder {
  const stoppedAtMs = host?.stoppedAt ? new Date(host.stoppedAt as any).getTime() : 0;
  if (!Number.isFinite(stoppedAtMs) || stoppedAtMs <= 0) {
    return { due: false, daysLeft: 0, stoppedAtMs: 0 };
  }
  const daysLeft = Math.ceil((stoppedAtMs - now) / (24 * 60 * 60 * 1000));
  const withinDays = normalizeHostRenewalDays(host?.renewalReminderDays);
  return { due: daysLeft >= 0 && daysLeft <= withinDays, daysLeft, stoppedAtMs };
}
