import { pushAgentRefresh } from "./agentEvents";
import { dbBool } from "./repositories/repositoryUtils";
import * as db from "./db";
import { mapWithConcurrency } from "./asyncPool";
import { canUseForwardRuleResource, clearLinkAccessScopeCache, getLinkAccessScope, type LinkAccessScope } from "./linkAccessView";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { pushTunnelEndpointRefresh } from "./routers/helpers";
import { appendPanelLog } from "./_core/panelLogger";
import { ruleRuntimeControlState, type RuntimeGroupState } from "./repositories/userForwardAccessRecovery";

export const RULE_RESOURCE_AUTHORIZATION_REVOKED_REASON = "资源授权已失效，请编辑规则并选择当前有权限的端口转发或隧道";

function positiveId(value: unknown) {
  const id = Number(value || 0);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

async function loadRuleResourceAccess(userId: number): Promise<LinkAccessScope | null> {
  const user = await db.getUserById(userId);
  if (!user) throw new Error("用户不存在");
  return getLinkAccessScope({ id: Number(user.id), role: String(user.role || "user") });
}

function ruleHasResourceAccess(rule: any, access: LinkAccessScope | null) {
  return canUseForwardRuleResource(rule, access);
}

/**
 * Stop, but do not delete, user-owned rules whose selected resource is no
 * longer usable. The rule stays editable so it can be moved to a new grant.
 */
export async function reconcileUserRuleResourceAuthorization(userId: number) {
  const [rules, access] = await Promise.all([
    db.getForwardRules(userId),
    loadRuleResourceAccess(userId),
  ]);
  const revokedRules = (rules as any[]).filter((rule) => !ruleHasResourceAccess(rule, access));
  const changedRules = revokedRules.filter((rule) => (
    dbBool(rule.isEnabled)
    || dbBool(rule.isRunning)
    || String(rule.protocolBlockReason || "") !== RULE_RESOURCE_AUTHORIZATION_REVOKED_REASON
  ));

  await mapWithConcurrency(changedRules, 8, async (rule) => {
    await db.updateForwardRule(Number(rule.id), {
      isEnabled: false,
      isRunning: false,
      disabledByUser: false,
      disabledByTunnel: false,
      disabledByGroup: false,
      protocolBlockReason: RULE_RESOURCE_AUTHORIZATION_REVOKED_REASON,
    } as any);
  });

  // Always resync revoked groups. A prior authorization update may have saved
  // the template before child synchronization or endpoint refresh completed.
  const groupIds = new Set(revokedRules.map((rule) => positiveId(rule.forwardGroupId)).filter(Boolean));
  const tunnelIds = new Set(changedRules
    .filter((rule) => !positiveId(rule.forwardGroupId))
    .map((rule) => positiveId(rule.tunnelId))
    .filter(Boolean));
  const hostIds = new Set(changedRules
    .filter((rule) => !positiveId(rule.forwardGroupId) && !positiveId(rule.tunnelId))
    .map((rule) => positiveId(rule.hostId))
    .filter(Boolean));

  await mapWithConcurrency(Array.from(groupIds), 4, async (groupId) => {
    await db.syncForwardGroupRules(groupId);
    await db.runForwardGroupFailover(groupId);
  });
  await mapWithConcurrency(Array.from(tunnelIds), 4, async (tunnelId) => {
    const tunnel = await db.getTunnelById(tunnelId);
    if (tunnel) await pushTunnelEndpointRefresh(tunnel, "rule-resource-authorization-revoked", { urgent: true });
  });
  for (const hostId of hostIds) {
    pushAgentRefresh(hostId, "rule-resource-authorization-revoked", { urgent: true });
  }

  const restoredRuleIds = await restoreReauthorizedRules(userId, rules as any[], access);

  return {
    disabledRuleIds: changedRules.map((rule) => Number(rule.id)),
    revokedRuleIds: revokedRules.map((rule) => Number(rule.id)),
    restoredRuleIds,
  };
}

/**
 * 授权回来了，因授权失效而停的规则自己恢复。
 *
 * 以前这类规则只能由用户编辑、或者一条条手动打开：套餐续上了、管理员把隧道权限
 * 重新勾上了，规则还是全停着。现在只要它停的原因就是「授权失效」、而现在又有权限，
 * 就按当前的隧道/转发资源/账户状态把它拉回来 —— 那些还不允许运行的，改记成对应的
 * 停用原因，等那边恢复时再由那条路径自动拉起。
 */
async function restoreReauthorizedRules(userId: number, rules: any[], access: LinkAccessScope | null) {
  const candidates = rules.filter((rule) => (
    !dbBool(rule.pendingDelete)
    && String(rule.protocolBlockReason || "") === RULE_RESOURCE_AUTHORIZATION_REVOKED_REASON
    && ruleHasResourceAccess(rule, access)
  ));
  if (candidates.length === 0) return [];
  const ownerAllowed = await db.forwardRuleOwnerAllowsRuntime(userId);
  const groupCache = new Map<number, RuntimeGroupState | null>();
  const restoredIds: number[] = [];
  const groupIds = new Set<number>();
  const tunnelIds = new Set<number>();
  const hostIds = new Set<number>();
  for (const rule of candidates) {
    const control = await ruleRuntimeControlState({
      ...rule,
      protocolBlockReason: null,
      disabledByGroup: false,
      disabledByTunnel: false,
    }, groupCache);
    const isEnabled = ownerAllowed && control.canEnable;
    await db.updateForwardRule(Number(rule.id), {
      isEnabled,
      isRunning: false,
      protocolBlockReason: null,
      disabledByUser: !ownerAllowed,
      disabledByGroup: control.blockedByGroup,
      disabledByTunnel: control.blockedByTunnel,
    } as any);
    if (isEnabled) restoredIds.push(Number(rule.id));
    const groupId = positiveId(rule.forwardGroupId);
    const tunnelId = positiveId(rule.tunnelId);
    if (groupId) groupIds.add(groupId);
    else if (tunnelId) tunnelIds.add(tunnelId);
    else if (positiveId(rule.hostId)) hostIds.add(positiveId(rule.hostId));
  }
  await mapWithConcurrency(Array.from(groupIds), 4, async (groupId) => {
    await db.syncForwardGroupRules(groupId);
    await db.runForwardGroupFailover(groupId);
  });
  await mapWithConcurrency(Array.from(tunnelIds), 4, async (tunnelId) => {
    const tunnel = await db.getTunnelById(tunnelId);
    if (tunnel) await pushTunnelEndpointRefresh(tunnel, "rule-resource-authorization-restored", { urgent: true });
  });
  for (const hostId of hostIds) {
    pushAgentRefresh(hostId, "rule-resource-authorization-restored", { urgent: true });
  }
  if (restoredIds.length > 0) {
    appendPanelLog("info", `[RuleRecovery] user=${userId} resumed ${restoredIds.length} rule(s) after resource authorization was restored`);
  }
  return restoredIds;
}

/** 名下有「因授权失效而停」规则的用户，给后台自愈扫描用。 */
export async function reconcileReauthorizedRulesForAllUsers() {
  const userIds = await db.getUserIdsWithRuleBlockReason(RULE_RESOURCE_AUTHORIZATION_REVOKED_REASON);
  let restored = 0;
  for (const userId of userIds) {
    try {
      const result = await withKeyedTaskLock(`user-resource-permissions:${userId}`, async () => {
        clearLinkAccessScopeCache();
        const [rules, access] = await Promise.all([
          db.getForwardRules(userId),
          loadRuleResourceAccess(userId),
        ]);
        return restoreReauthorizedRules(userId, rules as any[], access);
      });
      restored += result.length;
    } catch (error) {
      console.warn(`[RuleRecovery] authorization restore failed user=${userId}:`, error instanceof Error ? error.message : String(error));
    }
  }
  return restored;
}
