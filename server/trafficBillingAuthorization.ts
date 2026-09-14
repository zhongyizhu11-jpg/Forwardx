import { mapWithConcurrency } from "./asyncPool";
import * as db from "./db";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { clearLinkAccessScopeCache } from "./linkAccessView";
import { reconcileUserRuleResourceAuthorization } from "./ruleResourceAuthorization";
import { refreshUserForwardEndpoints } from "./routers/helpers";

export async function reconcileTrafficBillingAuthorization(reason: string) {
  clearLinkAccessScopeCache();
  let userIds: number[];
  try {
    userIds = await db.getNonAdminUserIds();
  } catch (error) {
    const failures = [{
      userId: null,
      error: `user enumeration failed: ${error instanceof Error ? error.message : String(error)}`,
    }];
    console.warn(`[TrafficBilling] authorization reconciliation failed reason=${reason} failures=all:${failures[0].error}`);
    return {
      affectedUsers: 0,
      restoredUsers: 0,
      disabledRules: 0,
      failures,
    };
  }
  const results = await mapWithConcurrency(userIds, 4, async (userId) => {
    try {
      const result = await withKeyedTaskLock(`user-resource-permissions:${userId}`, async () => {
        clearLinkAccessScopeCache();
        const recovery = await db.recoverUserForwardAccessIfEligible(userId);
        const authorization = await reconcileUserRuleResourceAuthorization(userId);
        await refreshUserForwardEndpoints(userId, reason, {
          urgent: true,
        });
        return { recovery, authorization };
      });
      return {
        userId,
        restored: !!result.recovery.restored,
        disabledRuleIds: result.authorization.disabledRuleIds,
      };
    } catch (error) {
      return {
        userId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  const failures = results.filter((result) => "error" in result);
  if (failures.length > 0) {
    console.warn(`[TrafficBilling] authorization reconciliation failed reason=${reason} failures=${failures.map((failure) => `${failure.userId}:${failure.error}`).join(",")}`);
  }
  return {
    affectedUsers: userIds.length,
    restoredUsers: results.filter((result) => "restored" in result && result.restored).length,
    disabledRules: results.reduce((total, result) => (
      total + ("disabledRuleIds" in result ? result.disabledRuleIds?.length ?? 0 : 0)
    ), 0),
    failures,
  };
}
