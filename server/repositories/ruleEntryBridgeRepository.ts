import { executeRaw, getDb, queryRaw, rawAffectedRows, rawEpochToDate } from "../dbRuntime";
import { boolLiteral, inList, quoteIdentifier } from "../dbCompat";
import { getSetting } from "./settingsRepository";
import { dbBool } from "./repositoryUtils";
import { normalizeForwardRuleProtocol } from "../../shared/forwardTypes";
import {
  RULE_SWITCH_BRIDGE_HOURS_SETTING,
  entryBridgePortConflictMessage,
  normalizeRuleSwitchBridgeHours,
} from "../../shared/ruleEntryBridge";

const normalizeForwardRuleProtocolForBridge = (value: unknown) => normalizeForwardRuleProtocol(value, "both");

/**
 * 换隧道后旧入口临时桥接的存取（表 forward_rule_entry_bridges，说明见 shared/ruleEntryBridge）。
 *
 * 「生效中」的桥接统一是这一个口径：没到期、规则还在、规则没在待删除。停用规则的桥接仍算
 * 占着端口（到期前规则随时可能再开，开了桥接就接着转），只是心跳那边不下发。
 */

export type RuleEntryBridgeRow = {
  id: number;
  ruleId: number;
  hostId: number;
  sourcePort: number;
  protocol: string;
  isRunning: boolean;
  runtimeTarget: string | null;
  createdAt: Date | null;
  expiresAt: Date | null;
};

const q = (id: string) => quoteIdentifier(id);
const BRIDGES = () => q("forward_rule_entry_bridges");
const RULES = () => q("forward_rules");

function nowSeconds(now = Date.now()) {
  return Math.floor(now / 1000);
}

function positiveIds(values: readonly unknown[]) {
  return Array.from(new Set(values.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
}

function toRow(raw: any): RuleEntryBridgeRow {
  return {
    id: Number(raw.id),
    ruleId: Number(raw.ruleId),
    hostId: Number(raw.hostId),
    sourcePort: Number(raw.sourcePort),
    protocol: normalizeForwardRuleProtocolForBridge(raw.protocol),
    isRunning: dbBool(raw.isRunning),
    runtimeTarget: raw.runtimeTarget === null || raw.runtimeTarget === undefined ? null : String(raw.runtimeTarget),
    createdAt: rawEpochToDate(raw.createdAt),
    expiresAt: rawEpochToDate(raw.expiresAt),
  };
}

/** 生效中的桥接：没到期 + 规则还在 + 规则不在待删除。b 是桥接表别名，r 是规则表别名。 */
function activeBridgeSql() {
  return `${q("b")}.${q("expiresAt")} > ?
    AND COALESCE(${q("r")}.${q("pendingDelete")}, ${boolLiteral(false)}) = ${boolLiteral(false)}`;
}

function bridgeColumns() {
  return ["id", "ruleId", "hostId", "sourcePort", "protocol", "isRunning", "runtimeTarget", "createdAt", "expiresAt"]
    .map((column) => `${q("b")}.${q(column)} AS ${q(column)}`)
    .join(", ");
}

/** 设置里的保留小时数（0 = 不建桥接）。 */
export async function getRuleSwitchBridgeHours(): Promise<number> {
  return normalizeRuleSwitchBridgeHours(await getSetting(RULE_SWITCH_BRIDGE_HOURS_SETTING));
}

/**
 * 规则换走入口后，在这些旧入口主机上留桥接，并把**这条规则所有**生效中的桥接的到期时间一起
 * 顺延到 now + hours。
 *
 * 为什么全部顺延：计时的意思是「规则在最近这次入口上稳定了多久」。规则 A→B→C 换了两次，
 * 手里还是 A 地址的客户端同样没来得及刷新 —— 它的桥接不能按第一次换的时间先过期。
 */
export async function recordRuleEntryBridges(input: {
  ruleId: number;
  hostIds: readonly number[];
  sourcePort: number;
  protocol: unknown;
  hours: number;
  now?: number;
}) {
  const db = await getDb();
  if (!db) return [] as number[];
  const ruleId = Number(input.ruleId);
  const sourcePort = Number(input.sourcePort);
  const hours = Math.max(0, Math.floor(Number(input.hours) || 0));
  if (!(ruleId > 0) || hours <= 0) return [] as number[];
  const now = nowSeconds(input.now);
  const expiresAt = now + hours * 3600;
  const protocol = normalizeForwardRuleProtocolForBridge(input.protocol);
  const hostIds = positiveIds(input.hostIds);
  if (sourcePort > 0 && sourcePort <= 65535) {
    for (const hostId of hostIds) {
      // 一条规则在一台主机上只留一条桥接（唯一键 ruleId + hostId）：先删后插，三种库写法一样。
      await executeRaw(`DELETE FROM ${BRIDGES()} WHERE ${q("ruleId")} = ? AND ${q("hostId")} = ?`, [ruleId, hostId]);
      await executeRaw(
        `INSERT INTO ${BRIDGES()} (${q("ruleId")}, ${q("hostId")}, ${q("sourcePort")}, ${q("protocol")}, ${q("isRunning")}, ${q("runtimeTarget")}, ${q("createdAt")}, ${q("expiresAt")}, ${q("updatedAt")})
         VALUES (?, ?, ?, ?, ${boolLiteral(false)}, NULL, ?, ?, ?)`,
        [ruleId, hostId, sourcePort, protocol, now, expiresAt, now],
      );
    }
  }
  await executeRaw(
    `UPDATE ${BRIDGES()} SET ${q("expiresAt")} = ?, ${q("updatedAt")} = ? WHERE ${q("ruleId")} = ? AND ${q("expiresAt")} > ?`,
    [expiresAt, now, ruleId, now],
  );
  return getRuleEntryBridgeHostIds(ruleId);
}

/** 这条规则现有桥接所在的主机（不论到没到期）：规则改动后要叫它们重算一次。 */
export async function getRuleEntryBridgeHostIds(ruleId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await queryRaw<{ hostId: number }>(
    `SELECT ${q("hostId")} FROM ${BRIDGES()} WHERE ${q("ruleId")} = ?`,
    [Number(ruleId)],
  );
  return positiveIds(rows.map((row) => row.hostId));
}

/**
 * 规则回到了这些主机（换回旧入口，或旧入口成了新入口组的一员）：那里的桥接让位给规则本身。
 * 返回被删掉的桥接所在的主机。
 */
export async function deleteRuleEntryBridgesOnHosts(ruleId: number, hostIds: readonly number[]): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const ids = positiveIds(hostIds);
  if (!(Number(ruleId) > 0) || ids.length === 0) return [];
  const list = inList(ids);
  const rows = await queryRaw<{ hostId: number }>(
    `SELECT ${q("hostId")} FROM ${BRIDGES()} WHERE ${q("ruleId")} = ? AND ${q("hostId")} IN ${list.sql}`,
    [Number(ruleId), ...list.params],
  );
  if (rows.length === 0) return [];
  await executeRaw(
    `DELETE FROM ${BRIDGES()} WHERE ${q("ruleId")} = ? AND ${q("hostId")} IN ${list.sql}`,
    [Number(ruleId), ...list.params],
  );
  return positiveIds(rows.map((row) => row.hostId));
}

/** 规则删掉了：它的桥接一起删。返回桥接所在的主机，调用方据此通知 Agent 撤掉监听。 */
export async function deleteRuleEntryBridgesForRules(ruleIds: readonly number[]): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const ids = positiveIds(ruleIds);
  if (ids.length === 0) return [];
  const list = inList(ids);
  const rows = await queryRaw<{ hostId: number }>(
    `SELECT ${q("hostId")} FROM ${BRIDGES()} WHERE ${q("ruleId")} IN ${list.sql}`,
    list.params,
  );
  if (rows.length === 0) return [];
  await executeRaw(`DELETE FROM ${BRIDGES()} WHERE ${q("ruleId")} IN ${list.sql}`, list.params);
  return positiveIds(rows.map((row) => row.hostId));
}

/**
 * 删掉到期的桥接（以及规则已经不在了的孤行），返回涉及的主机：调度器随后逐台推一次刷新，
 * Agent 才会及时撤掉监听 —— 否则稳定心跳计划会一直沿用到下一次整轮对账。
 */
export async function deleteExpiredRuleEntryBridges(now = Date.now()): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const cutoff = nowSeconds(now);
  const orphanSql = `NOT EXISTS (SELECT 1 FROM ${RULES()} WHERE ${RULES()}.${q("id")} = ${BRIDGES()}.${q("ruleId")})`;
  const rows = await queryRaw<{ hostId: number }>(
    `SELECT ${q("hostId")} FROM ${BRIDGES()} WHERE ${q("expiresAt")} <= ? OR ${orphanSql}`,
    [cutoff],
  );
  if (rows.length === 0) return [];
  await executeRaw(`DELETE FROM ${BRIDGES()} WHERE ${q("expiresAt")} <= ? OR ${orphanSql}`, [cutoff]);
  return positiveIds(rows.map((row) => row.hostId));
}

/** 心跳用：这台主机上生效中的桥接，只取启用中的规则（停用规则的桥接不下发）。 */
export async function getActiveRuleEntryBridgesForHost(hostId: number, now = Date.now()): Promise<RuleEntryBridgeRow[]> {
  const db = await getDb();
  if (!db || !(Number(hostId) > 0)) return [];
  const rows = await queryRaw<any>(
    `SELECT ${bridgeColumns()}
       FROM ${BRIDGES()} ${q("b")}
       INNER JOIN ${RULES()} ${q("r")} ON ${q("r")}.${q("id")} = ${q("b")}.${q("ruleId")}
      WHERE ${q("b")}.${q("hostId")} = ?
        AND ${activeBridgeSql()}
        AND ${q("r")}.${q("isEnabled")} = ${boolLiteral(true)}
      ORDER BY ${q("b")}.${q("id")} ASC`,
    [Number(hostId), nowSeconds(now)],
  );
  return rows.map(toRow);
}

/** 规则列表用：这些规则各自生效中的桥接（带旧入口主机名）。 */
export async function getActiveRuleEntryBridgesForRules(ruleIds: readonly number[], now = Date.now()) {
  const db = await getDb();
  const ids = positiveIds(ruleIds);
  const byRule = new Map<number, Array<RuleEntryBridgeRow & { hostName: string | null }>>();
  if (!db || ids.length === 0) return byRule;
  for (let index = 0; index < ids.length; index += 400) {
    const list = inList(ids.slice(index, index + 400));
    const rows = await queryRaw<any>(
      `SELECT ${bridgeColumns()}, ${q("h")}.${q("name")} AS ${q("hostName")}
         FROM ${BRIDGES()} ${q("b")}
         INNER JOIN ${RULES()} ${q("r")} ON ${q("r")}.${q("id")} = ${q("b")}.${q("ruleId")}
         LEFT JOIN ${q("hosts")} ${q("h")} ON ${q("h")}.${q("id")} = ${q("b")}.${q("hostId")}
        WHERE ${q("b")}.${q("ruleId")} IN ${list.sql}
          AND ${activeBridgeSql()}
        ORDER BY ${q("b")}.${q("id")} ASC`,
      [...list.params, nowSeconds(now)],
    );
    for (const raw of rows) {
      const row = { ...toRow(raw), hostName: raw.hostName === null || raw.hostName === undefined ? null : String(raw.hostName) };
      const items = byRule.get(row.ruleId) || [];
      items.push(row);
      byRule.set(row.ruleId, items);
    }
  }
  return byRule;
}

/**
 * 这台主机上被别的规则的桥接占着的端口（给端口冲突检查和自动分配用）。
 * excludeRuleIds 里的规则自己的桥接不算：规则换回旧入口时，老端口要能还给它。
 * 端口按「一个端口一条规则」算，不分 TCP / UDP —— 和规则之间的冲突口径一致
 * （Agent 的本地状态按端口记，见 tunnelRepository 的 protocolConflictCondition）。
 */
export async function getActiveEntryBridgesOnHost(
  hostId: number,
  excludeRuleIds: readonly unknown[] = [],
  port?: number,
  now = Date.now(),
): Promise<RuleEntryBridgeRow[]> {
  const db = await getDb();
  if (!db || !(Number(hostId) > 0)) return [];
  const excluded = positiveIds(excludeRuleIds);
  const params: any[] = [Number(hostId), nowSeconds(now)];
  let extra = "";
  if (port !== undefined) {
    extra += ` AND ${q("b")}.${q("sourcePort")} = ?`;
    params.push(Number(port));
  }
  if (excluded.length > 0) {
    const list = inList(excluded);
    extra += ` AND ${q("b")}.${q("ruleId")} NOT IN ${list.sql}`;
    params.push(...list.params);
  }
  const rows = await queryRaw<any>(
    `SELECT ${bridgeColumns()}
       FROM ${BRIDGES()} ${q("b")}
       INNER JOIN ${RULES()} ${q("r")} ON ${q("r")}.${q("id")} = ${q("b")}.${q("ruleId")}
      WHERE ${q("b")}.${q("hostId")} = ?
        AND ${activeBridgeSql()}${extra}`,
    params,
  );
  return rows.map(toRow);
}

/**
 * 端口被桥接占着时的报错；没被占返回 null。调用方在「端口已被占用」报错前先问一句，
 * 让人知道这是临时的、什么时候放开，而不是去找一条根本不存在的规则。
 */
export async function entryBridgePortConflictMessageForHosts(
  hostIds: readonly unknown[],
  port: number,
  excludeRuleIds: readonly unknown[] = [],
): Promise<string | null> {
  for (const hostId of positiveIds(hostIds)) {
    const [bridge] = await getActiveEntryBridgesOnHost(hostId, excludeRuleIds, Number(port));
    if (bridge) {
      return entryBridgePortConflictMessage({
        port: Number(port),
        ruleId: bridge.ruleId,
        expiresAtMs: bridge.expiresAt ? bridge.expiresAt.getTime() : Date.now(),
      });
    }
  }
  return null;
}

/** Agent 报上来的运行状态。 */
export async function markRuleEntryBridgeRunning(bridgeId: number, running: boolean) {
  const db = await getDb();
  if (!db || !(Number(bridgeId) > 0)) return 0;
  const result = await executeRaw(
    `UPDATE ${BRIDGES()} SET ${q("isRunning")} = ?, ${q("updatedAt")} = ? WHERE ${q("id")} = ?`,
    [!!running, nowSeconds(), Number(bridgeId)],
  );
  return rawAffectedRows(result);
}

/** 目标变了（规则又换了入口 / 改了端口）：记下新目标、标成未运行，心跳随即重新下发。 */
export async function resetRuleEntryBridgeRuntime(bridgeId: number, runtimeTarget: string) {
  const db = await getDb();
  if (!db || !(Number(bridgeId) > 0)) return;
  await executeRaw(
    `UPDATE ${BRIDGES()} SET ${q("runtimeTarget")} = ?, ${q("isRunning")} = ${boolLiteral(false)}, ${q("updatedAt")} = ? WHERE ${q("id")} = ?`,
    [runtimeTarget, nowSeconds(), Number(bridgeId)],
  );
}

export async function getRuleEntryBridgeById(bridgeId: number): Promise<RuleEntryBridgeRow | null> {
  const db = await getDb();
  if (!db || !(Number(bridgeId) > 0)) return null;
  const rows = await queryRaw<any>(`SELECT * FROM ${BRIDGES()} WHERE ${q("id")} = ?`, [Number(bridgeId)]);
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * 规则现在落在这台主机上的那些桥接所在的主机：这台机器的入口地址变了，桥接的目标跟着变，
 * 要叫那些旧入口重算（见 hostAddressRuntime.refreshAgentsAffectedByHostAddress）。
 */
export async function getEntryBridgeHostIdsForRulesOnHost(hostId: number, now = Date.now()): Promise<number[]> {
  const db = await getDb();
  if (!db || !(Number(hostId) > 0)) return [];
  const rows = await queryRaw<{ hostId: number }>(
    `SELECT ${q("b")}.${q("hostId")} AS ${q("hostId")}
       FROM ${BRIDGES()} ${q("b")}
       INNER JOIN ${RULES()} ${q("r")} ON ${q("r")}.${q("id")} = ${q("b")}.${q("ruleId")}
      WHERE ${q("r")}.${q("hostId")} = ?
        AND ${activeBridgeSql()}`,
    [Number(hostId), nowSeconds(now)],
  );
  return positiveIds(rows.map((row) => row.hostId));
}
