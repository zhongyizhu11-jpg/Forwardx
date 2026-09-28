import * as db from "./db";
import { appendPanelLog } from "./_core/panelLogger";
import { afterDatabaseCommit } from "./dbRuntime";
import { dbBool } from "./repositories/repositoryUtils";
import { withTrafficBillingUserLock } from "./keyedTaskLock";
import { refreshBlockedRuleRuntime, resumeBlockedRules } from "./ruleBlockRecovery";

/**
 * 流量计费余额不足时，只停走计费资源的那几条规则。
 *
 * 以前余额一不足就暂停整个账户：他名下所有规则一起停，包括走自己机器、走套餐资源、
 * 根本不按流量扣费的规则。现在：
 *   - 有套餐或管理员手动开的转发权限：账户不动，只停走计费资源的规则，规则上写明
 *     原因；余额回到正数（充值、管理员加余额）后自动恢复。
 *   - 转发权限完全来自流量计费（没有套餐、也没有手动权限）：和以前一样暂停账户 ——
 *     没有余额他就没有任何转发权限。
 */
export const TRAFFIC_BILLING_BALANCE_BLOCK_REASON = "流量计费余额不足，充值后自动恢复";

function hasBalance(user: any) {
  return Number(user?.balanceCents || 0) > 0;
}

/** 除了流量计费之外，他还有没有转发权限（套餐 / 管理员手动开的）。 */
async function hasNonBillingForwardAccess(user: any) {
  const limits = await db.getEffectiveUserPlanLimits(Number(user.id));
  return !!db.mergeManualAndPlanLimits(user, limits).canAddRules;
}

/**
 * 停掉这个人走计费资源的规则。已经因为别的原因停着的（隧道停用、账户暂停……）也打上
 * 这个原因，免得那边一恢复就在没余额的情况下跑起来。
 */
export async function stopTrafficBillingRulesForUser(userId: number, reason: string) {
  const rules = (await db.getForwardRules(userId) as any[]).filter((rule) => (
    String(rule.protocolBlockReason || "") !== TRAFFIC_BILLING_BALANCE_BLOCK_REASON
    && (
      dbBool(rule.isEnabled)
      || dbBool(rule.disabledByUser)
      || dbBool(rule.disabledByTunnel)
      || dbBool(rule.disabledByGroup)
    )
  ));
  if (rules.length === 0) return [];
  const billed = await db.findTrafficBillingResourcesForRules(rules);
  const targets = rules.filter((rule) => billed.has(Number(rule.id)));
  if (targets.length === 0) return [];
  for (const rule of targets) {
    await db.updateForwardRule(Number(rule.id), {
      isEnabled: false,
      isRunning: false,
      protocolBlockReason: TRAFFIC_BILLING_BALANCE_BLOCK_REASON,
    } as any);
  }
  appendPanelLog("warn", `[RuleStop] user=${userId} stopped ${targets.length} traffic-billed rule(s) reason=${reason}; other rules keep running and these resume after a top-up`);
  // 调用方可能正持有转发组同步锁（删子规则结算时）或在事务里：刷新放到提交之后、
  // 不等它跑完，否则同步锁不可重入会卡死，事务里同步转发组也会直接报错。
  await afterDatabaseCommit(() => {
    void refreshBlockedRuleRuntime(targets, "traffic-billing-balance-unavailable").catch((error) => {
      console.warn(`[TrafficBilling] runtime refresh after stopping billed rules failed user=${userId}:`, error instanceof Error ? error.message : String(error));
    });
  });
  return targets.map((rule) => Number(rule.id));
}

/** 余额回到正数后，把因余额不足停下的规则拉回来。 */
export async function resumeTrafficBillingRulesForUser(userId: number) {
  const user = await db.getUserById(userId);
  if (!user || !hasBalance(user)) return [];
  const rules = (await db.getForwardRules(userId) as any[]).filter((rule) => (
    String(rule.protocolBlockReason || "") === TRAFFIC_BILLING_BALANCE_BLOCK_REASON
  ));
  const restored = await resumeBlockedRules(userId, rules, "traffic-billing-balance-restored");
  if (restored.length > 0) {
    appendPanelLog("info", `[RuleRecovery] user=${userId} resumed ${restored.length} traffic-billed rule(s) after the balance was topped up`);
  }
  return restored;
}

/**
 * 余额不足时调用（扣费后变负、或者扣费前发现没余额）。管理员不受影响。
 * 返回 accountPaused：是否按老办法暂停了整个账户（只有纯计费用户会）。
 */
export async function handleTrafficBillingShortfall(userId: number, reason: string) {
  const user = await db.getUserById(userId);
  if (!user || String((user as any).role || "") === "admin") return { accountPaused: false, stoppedRuleIds: [] as number[] };
  if (!(await hasNonBillingForwardAccess(user))) {
    await db.setUserForwardAccess(userId, false, "traffic_billing_balance");
    return { accountPaused: true, stoppedRuleIds: [] as number[] };
  }
  const stoppedRuleIds = await stopTrafficBillingRulesForUser(userId, reason);
  return { accountPaused: false, stoppedRuleIds };
}

/**
 * 转发权限确认可用之后调用：有余额就恢复因余额停下的规则，没余额就只停计费资源上的。
 * 返回恢复了的规则 id。
 */
export async function reconcileTrafficBillingRuleBlocks(userId: number) {
  const user = await db.getUserById(userId);
  if (!user || String((user as any).role || "") === "admin") return [];
  if (hasBalance(user)) return resumeTrafficBillingRulesForUser(userId);
  if (await hasNonBillingForwardAccess(user)) {
    await stopTrafficBillingRulesForUser(userId, "balance-unavailable");
  }
  return [];
}

/**
 * 自愈扫描用：
 *   1. 旧版本把有套餐的人也整户暂停了 —— 撤掉账户暂停，只停计费资源上的规则；
 *   2. 因余额停下、现在已经有余额的规则 —— 恢复。
 */
export async function reconcileTrafficBillingRuleBlocksForAllUsers() {
  let restored = 0;
  for (const userId of await db.getUserIdsWithForwardAccessPause("traffic_billing_balance")) {
    try {
      const user = await db.getUserById(userId);
      if (!user || !(await hasNonBillingForwardAccess(user))) continue;
      const recovery = await db.recoverUserForwardAccessIfEligible(userId);
      restored += recovery.restoredRuleIds?.length || 0;
    } catch (error) {
      console.warn(`[RuleRecovery] traffic billing pause conversion failed user=${userId}:`, error instanceof Error ? error.message : String(error));
    }
  }
  for (const userId of await db.getUserIdsWithRuleBlockReason(TRAFFIC_BILLING_BALANCE_BLOCK_REASON)) {
    try {
      const resumed = await withTrafficBillingUserLock(
        userId,
        () => resumeTrafficBillingRulesForUser(userId),
      );
      restored += resumed.length;
    } catch (error) {
      console.warn(`[RuleRecovery] traffic billing restore failed user=${userId}:`, error instanceof Error ? error.message : String(error));
    }
  }
  return restored;
}
