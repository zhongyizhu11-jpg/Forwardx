/**
 * 套餐的多周期定价。
 *
 * 原来一个套餐只有一个周期：要卖月付和年付，就得建两个套餐 —— 商店里同一个产品
 * 占两张卡，改一次配置要改两遍，改漏一个就是两张卡说的话不一致；年付便宜多少还
 * 得客户自己拿计算器按。
 *
 * 现在一个套餐挂一组「周期 → 价格」。这一份是纯逻辑：哪些档可买、默认选哪档、
 * 某一档相对最短那档省了多少。判错的后果是真金白银 —— 少收钱或者多收钱 —— 所以
 * 单独拆出来测，网络和库表那一半留在服务端。
 */

export type PlanPriceTier = {
  /** 天数。0 不允许：那是「永久」，不该出现在可选周期里。 */
  durationDays: number;
  priceCents: number;
};

export type PlanPricingOption = PlanPriceTier & {
  /** 每天多少分。用来比较划算程度 —— 直接比总价会得出「月付最便宜」这种废话。 */
  perDayCents: number;
  /**
   * 相对**最短那一档**省了百分之几，四舍五入到整数；不便宜就是 0。
   *
   * 基准取最短档而不是最贵档：客户心里的参照物是「按月买要多少钱」。
   */
  discountPercent: number;
};

/** 常用周期。管理端下拉和商店标签共用这一份，免得两边各写一遍、改了一边忘另一边。 */
export const PLAN_DURATION_PRESETS: ReadonlyArray<{ days: number; label: string }> = [
  { days: 30, label: "一个月" },
  { days: 90, label: "三个月" },
  { days: 180, label: "半年" },
  { days: 365, label: "一年" },
  { days: 730, label: "两年" },
];

/** 一个套餐最多挂几档。够用就好 —— 商店卡片上摆十个按钮没人看得下去。 */
export const PLAN_PRICE_TIER_LIMIT = 6;

export function planDurationLabel(days?: number | null): string {
  const value = Number(days || 0);
  if (value <= 0) return "永久";
  return PLAN_DURATION_PRESETS.find((item) => item.days === value)?.label || `${value} 天`;
}

function toInt(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : 0;
}

/**
 * 把管理端填的那张表洗干净：丢掉非法行、同一个周期只留**第一条**、按天数升序。
 *
 * 「只留第一条」而不是最后一条：管理员看到的顺序就是从上到下，重复填时上面那行
 * 是他先写的那个价。价格允许为 0（送的、内部用的套餐），周期必须为正。
 */
export function normalizePlanPriceTiers(rows: ReadonlyArray<Partial<PlanPriceTier>> | null | undefined): PlanPriceTier[] {
  const seen = new Set<number>();
  const out: PlanPriceTier[] = [];
  for (const row of rows || []) {
    const durationDays = toInt(row?.durationDays);
    const priceCents = toInt(row?.priceCents);
    if (durationDays <= 0 || priceCents < 0) continue;
    if (seen.has(durationDays)) continue;
    seen.add(durationDays);
    out.push({ durationDays, priceCents });
  }
  return out.sort((a, b) => a.durationDays - b.durationDays);
}

/**
 * 这个套餐可买的全部档位。
 *
 * 没配多周期的套餐（存量数据全是这样）退回它自己那一档 —— 升级不需要迁移，界面
 * 上也看不出区别：一个档位就是原来的样子。
 */
export function planPricingOptions(
  plan: { durationDays?: unknown; priceCents?: unknown },
  tiers?: ReadonlyArray<Partial<PlanPriceTier>> | null,
): PlanPricingOption[] {
  const normalized = normalizePlanPriceTiers(tiers);
  const base: PlanPriceTier[] = normalized.length > 0
    ? normalized
    : [{ durationDays: Math.max(1, toInt(plan?.durationDays) || 30), priceCents: Math.max(0, toInt(plan?.priceCents)) }];

  const shortest = base[0];
  const baselinePerDay = shortest.priceCents / shortest.durationDays;
  return base.map((tier) => {
    const perDayCents = tier.priceCents / tier.durationDays;
    // 基准是 0（免费套餐）时不谈折扣：除下去要么是 0 要么是无穷。
    const discountPercent = baselinePerDay > 0 && perDayCents < baselinePerDay
      ? Math.round((1 - perDayCents / baselinePerDay) * 100)
      : 0;
    return { ...tier, perDayCents, discountPercent };
  });
}

/**
 * 折算成「每月多少钱」。
 *
 * 客户比价时心里的单位是月，不是天也不是这一档的总价。商店卡片和管理端定价表都用
 * 这一个换算 —— 各写一遍的话，同一档会在两个地方显示成两个数。
 */
export function planMonthlyEquivalentCents(option: { perDayCents: number }): number {
  return Math.round(Number(option?.perDayCents || 0) * 30);
}

/**
 * 默认选哪一档。
 *
 * 取**总价最低**的那档，不是每天最划算的那档。后者通常是年付 —— 一进商店就默认
 * 选中金额最大的那个，点错一下就是一年的钱，这种默认值不该由我们替客户做。省多少
 * 用角标标出来就够了，想买长周期的人自己会点。
 */
export function defaultPricingOption(options: ReadonlyArray<PlanPricingOption>): PlanPricingOption | null {
  if (options.length === 0) return null;
  return options.reduce((best, item) => {
    if (item.priceCents !== best.priceCents) return item.priceCents < best.priceCents ? item : best;
    // 同价时选周期长的：一样的钱，多给几天。
    return item.durationDays > best.durationDays ? item : best;
  });
}

/**
 * 客户选的这一档还在不在。
 *
 * 下单和收款之间隔着一次跳转，管理员完全可能在这中间改了套餐 —— 认不出来的档位
 * 必须拒掉，而不是拿默认档顶上：那会变成「我买的是年付，开出来是月付」。
 */
export function findPricingOption(
  options: ReadonlyArray<PlanPricingOption>,
  durationDays: unknown,
): PlanPricingOption | null {
  const days = toInt(durationDays);
  if (days <= 0) return null;
  return options.find((item) => item.durationDays === days) || null;
}

/**
 * 续期时按哪一档扣。
 *
 * 优先续**上次买的那一档** —— 客户按月付的，不该某天醒来发现被扣了一年的钱。
 * 那一档被管理员下掉了就退回默认档，并且把这件事讲清楚（调用方据此写日志）。
 */
export function renewalPricingOption(
  options: ReadonlyArray<PlanPricingOption>,
  purchasedDurationDays: unknown,
): { option: PlanPricingOption | null; fellBack: boolean } {
  const exact = findPricingOption(options, purchasedDurationDays);
  if (exact) return { option: exact, fellBack: false };
  return { option: defaultPricingOption(options), fellBack: true };
}
