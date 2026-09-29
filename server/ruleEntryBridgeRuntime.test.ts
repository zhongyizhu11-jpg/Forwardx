import assert from "node:assert/strict";
import test from "node:test";

import { entryBridgeRuntimeRule, isEntryBridgeRuntimeRule, planEntryBridgeRuntime } from "./ruleEntryBridges";
import { ENTRY_BRIDGE_RULE_ID_BASE } from "../shared/ruleEntryBridge";

/**
 * 心跳里「桥接合成成规则行」的纯计算（server/ruleEntryBridges.planEntryBridgeRuntime）。
 * 真库、真心跳的整条路见 ruleEntryBridgeSwitch.test.ts。
 */

const bridge = (overrides: Record<string, any> = {}) => ({
  id: 5,
  ruleId: 10,
  hostId: 1,
  sourcePort: 40981,
  protocol: "both",
  isRunning: true,
  runtimeTarget: "203.0.113.2:40981",
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 3600_000),
  ...overrides,
});
const rule = (overrides: Record<string, any> = {}) => ({
  id: 10,
  hostId: 2,
  userId: 3,
  sourcePort: 40981,
  protocol: "both",
  isEnabled: true,
  pendingDelete: false,
  isForwardGroupTemplate: false,
  ...overrides,
});
const hosts = new Map<number, any>([
  [1, { id: 1, ip: "203.0.113.1" }],
  [2, { id: 2, ip: "203.0.113.2" }],
  [4, { id: 4, ip: "203.0.113.4", ddnsEnabled: true, ddnsDomain: "po02.example.com" }],
  [6, { id: 6, ip: "2001:db8::6" }],
]);
const plan = (input: { bridges?: any[]; rules?: any[]; localRules?: any[] }) => planEntryBridgeRuntime({
  hostId: 1,
  bridges: input.bridges ?? [bridge()],
  rulesById: new Map((input.rules ?? [rule()]).map((item) => [item.id, item])),
  hostsById: hosts,
  localRules: input.localRules ?? [],
});

test("合成出一条最朴素的 iptables 规则行：桥接编号、旧端口、指向规则当前入口", () => {
  const { rows, retarget } = plan({});
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.id, ENTRY_BRIDGE_RULE_ID_BASE + 5);
  assert.equal(row.forwardType, "iptables");
  assert.equal(row.hostId, 1);
  assert.equal(row.sourcePort, 40981);
  assert.equal(row.targetIp, "203.0.113.2");
  assert.equal(row.targetPort, 40981);
  assert.equal(row.protocol, "both");
  assert.equal(row.tunnelId, null);
  assert.equal(row.failoverEnabled, false);
  assert.equal(row.userId, 3);
  assert.equal(row.isRunning, true);
  assert.equal(isEntryBridgeRuntimeRule(row), true);
  assert.equal(isEntryBridgeRuntimeRule(rule()), false);
  assert.deepEqual(retarget, []);
});

test("规则又换了入口 / 改了端口：目标跟过去，按未运行处理并记下新目标", () => {
  const { rows, retarget } = plan({ rules: [rule({ hostId: 4, sourcePort: 50000 })] });
  assert.equal(rows[0].targetIp, "po02.example.com", "按订阅用的首选入口地址（域名优先）");
  assert.equal(rows[0].targetPort, 50000);
  assert.equal(rows[0].isRunning, false);
  assert.deepEqual(retarget, [{ bridgeId: 5, runtimeTarget: "po02.example.com:50000" }]);
});

test("IPv6 入口地址按带方括号的形式记目标", () => {
  const { retarget } = plan({ rules: [rule({ hostId: 6 })] });
  assert.deepEqual(retarget, [{ bridgeId: 5, runtimeTarget: "[2001:db8::6]:40981" }]);
});

test("不下发的几种：规则停用 / 待删除 / 被闸掉 / 成了转发组模板 / 回到了这台机器 / 规则没了", () => {
  for (const item of [
    rule({ isEnabled: false }),
    rule({ pendingDelete: true }),
    rule({ isForwardGroupTemplate: true }),
    rule({ hostId: 1 }),
    rule({ hostId: 99 }),
    rule({ sourcePort: 0 }),
  ]) {
    assert.deepEqual(plan({ rules: [item] }).rows, [], JSON.stringify(item));
  }
  assert.deepEqual(plan({ rules: [] }).rows, []);
});

test("这台机器上有真规则用着同一个端口：端口归真规则，桥接不下发", () => {
  assert.deepEqual(plan({ localRules: [{ id: 77, sourcePort: 40981, isEnabled: true, pendingDelete: false }] }).rows, []);
  // 停用的真规则不占
  assert.equal(plan({ localRules: [{ id: 77, sourcePort: 40981, isEnabled: false, pendingDelete: false }] }).rows.length, 1);
});

test("同一个端口上只下发一条桥接", () => {
  const { rows } = plan({
    bridges: [bridge(), bridge({ id: 6, ruleId: 11 })],
    rules: [rule(), rule({ id: 11 })],
  });
  assert.deepEqual(rows.map((row) => row.id), [ENTRY_BRIDGE_RULE_ID_BASE + 5]);
});

test("桥接编号超出编号段时跳过，不让整次心跳失败", () => {
  assert.deepEqual(plan({ bridges: [bridge({ id: 999_999_999 })] }).rows, []);
});

test("entryBridgeRuntimeRule 带上桥接标记，下发流程据此区别对待", () => {
  const row = entryBridgeRuntimeRule({ bridge: bridge(), hostId: 1, ownerUserId: 3, targetAddress: "203.0.113.2", targetPort: 40981, isRunning: false });
  assert.deepEqual({ bridgeId: row.entryBridge.bridgeId, ruleId: row.entryBridge.ruleId }, { bridgeId: 5, ruleId: 10 });
});
