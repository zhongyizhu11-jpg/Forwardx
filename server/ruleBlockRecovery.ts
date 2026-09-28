import { pushAgentRefresh } from "./agentEvents";
import * as db from "./db";
import { mapWithConcurrency } from "./asyncPool";
import { pushTunnelEndpointRefresh } from "./routers/helpers";
import { ruleRuntimeControlState, type RuntimeGroupState } from "./repositories/userForwardAccessRecovery";

function positiveId(value: unknown) {
  const id = Number(value || 0);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

/**
 * 让这些规则的运行端重新拿配置：转发组重新同步子规则，隧道刷新两端，普通规则刷新入口机。
 * 传入的是规则主体（用户能看到的那条），不是转发组生成的子规则。
 */
export async function refreshBlockedRuleRuntime(rules: any[], reason: string) {
  const groupIds = new Set<number>();
  const tunnelIds = new Set<number>();
  const hostIds = new Set<number>();
  for (const rule of rules) {
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
    if (tunnel) await pushTunnelEndpointRefresh(tunnel, reason, { urgent: true });
  });
  for (const hostId of hostIds) {
    pushAgentRefresh(hostId, reason, { urgent: true });
  }
}

/**
 * 把因某个原因（protocolBlockReason）停下的规则拉回来。
 *
 * 调用方负责确认「原因已经消除」。这里按当前的隧道 / 转发资源 / 账户状态决定能不能
 * 真的启用：还不允许运行的，改记成对应的停用原因（disabledByTunnel 等），等那边恢复时
 * 由那条路径自动拉起，不会卡在这里。返回真正启用了的规则 id。
 */
export async function resumeBlockedRules(userId: number, rules: any[], reason: string) {
  if (rules.length === 0) return [];
  const ownerAllowed = await db.forwardRuleOwnerAllowsRuntime(userId);
  const groupCache = new Map<number, RuntimeGroupState | null>();
  const restoredIds: number[] = [];
  for (const rule of rules) {
    const control = await ruleRuntimeControlState({
      ...rule,
      protocolBlockReason: null,
      disabledByGroup: false,
      disabledByTunnel: false,
    }, groupCache);
    const canEnable = ownerAllowed && control.canEnable;
    const portConflict = canEnable ? await db.forwardRuleRestorePortConflict(rule) : null;
    const isEnabled = canEnable && !portConflict;
    await db.updateForwardRule(Number(rule.id), {
      isEnabled,
      isRunning: false,
      protocolBlockReason: portConflict,
      disabledByUser: !ownerAllowed,
      disabledByGroup: control.blockedByGroup,
      disabledByTunnel: control.blockedByTunnel,
    } as any);
    if (isEnabled) restoredIds.push(Number(rule.id));
  }
  await refreshBlockedRuleRuntime(rules, reason);
  return restoredIds;
}
