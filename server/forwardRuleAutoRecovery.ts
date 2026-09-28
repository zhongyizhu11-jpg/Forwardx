import * as db from "./db";
import { appendPanelLog } from "./_core/panelLogger";
import { trafficBillingUserLockKey, withKeyedTaskLock } from "./keyedTaskLock";
import { restoreUserForwardRulesAfterAccessRecovery } from "./repositories/userForwardAccessRecovery";
import { reconcileReauthorizedRulesForAllUsers } from "./ruleResourceAuthorization";

/**
 * 被系统连带停掉的规则，原因消除后自动恢复。
 *
 * 规则被停有两类：
 *   - 手动关掉的：只有人能再打开，这里不碰。
 *   - 系统连带停的：隧道停用（disabledByTunnel）、转发资源停用（disabledByGroup）、
 *     账户暂停 —— 到期、流量用尽、余额不足、被停用（disabledByUser）、
 *     资源授权失效（protocolBlockReason = 授权失效）。
 *
 * 第二类在「原因消除」的那一步本来就会被拉回来；这个扫描兜的是那一步没走到的
 * 情况（面板中途重启、恢复时抛错、几件事并发把标记写乱了）。以前漏一次，一整条
 * 隧道的规则就停在那里，只能一条条手动打开。
 */
export async function healAutoStoppedRules(reason = "auto-heal") {
  // 管理员不该被系统暂停；旧版本留下的这类暂停先撤掉，下面的账户恢复就会把他的规则拉回来。
  await db.releaseAutomaticAdminForwardPauses();
  const linkResult = await db.healAutoStoppedForwardRules(reason);

  let userRules = 0;
  for (const userId of await db.getUserIdsWithAccessPausedRules()) {
    try {
      // 和计费/套餐变更走同一把锁：不会跟一次正在进行的暂停抢着写。
      const result = await withKeyedTaskLock(
        trafficBillingUserLockKey(userId),
        () => restoreUserForwardRulesAfterAccessRecovery(userId),
      );
      userRules += result.enabledRuleIds.length;
    } catch (error) {
      console.warn(`[RuleRecovery] access restore failed user=${userId}:`, error instanceof Error ? error.message : String(error));
    }
  }

  const authorizationRules = await reconcileReauthorizedRulesForAllUsers();

  if (userRules > 0) {
    appendPanelLog("info", `[RuleRecovery] ${reason}: resumed ${userRules} rule(s) whose owner's forwarding access is active again`);
  }
  return { ...linkResult, userRules, authorizationRules };
}
