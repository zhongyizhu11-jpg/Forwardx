import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RULE_SWITCH_BRIDGE_HOURS,
  ENTRY_BRIDGE_RULE_ID_BASE,
  MAX_RULE_SWITCH_BRIDGE_HOURS,
  describeEntryBridgeRemaining,
  entryBridgeHostsForSwitch,
  entryBridgeIdFromRuleId,
  entryBridgePortConflictMessage,
  entryBridgeRuleId,
  formatEntryBridgeNote,
  isEntryBridgeRuleId,
  normalizeRuleSwitchBridgeHours,
} from "./ruleEntryBridge";
import {
  PROXY_INBOUND_TRAFFIC_RULE_ID_BASE,
  isProxyInboundTrafficRuleId,
  proxyInboundTrafficRuleId,
} from "./proxyInboundTraffic";

test("桥接 id 与下发用的 ruleId 来回换算不丢，且在 int32 范围内", () => {
  for (const id of [1, 2, 99, 123_456, 147_483_647]) {
    const ruleId = entryBridgeRuleId(id);
    assert.ok(ruleId <= 2_147_483_647, String(ruleId));
    assert.equal(isEntryBridgeRuleId(ruleId), true);
    assert.equal(entryBridgeIdFromRuleId(ruleId), id);
  }
  for (const bad of [0, -1, 1.5, 147_483_648]) {
    assert.throws(() => entryBridgeRuleId(bad), String(bad));
  }
});

test("真规则、落地入站、桥接三段编号互不重叠", () => {
  for (const ruleId of [1, 10, 999_999_999, ENTRY_BRIDGE_RULE_ID_BASE]) {
    assert.equal(isEntryBridgeRuleId(ruleId), false, String(ruleId));
    assert.equal(entryBridgeIdFromRuleId(ruleId), 0);
  }
  const maxInbound = proxyInboundTrafficRuleId(PROXY_INBOUND_TRAFFIC_RULE_ID_BASE - 1);
  assert.equal(isEntryBridgeRuleId(maxInbound), false);
  assert.equal(isProxyInboundTrafficRuleId(maxInbound), true);
  // 以前入站只判下界，桥接的编号会被当成入站去查主人。
  assert.equal(isProxyInboundTrafficRuleId(entryBridgeRuleId(1)), false);
  assert.equal(isProxyInboundTrafficRuleId(entryBridgeRuleId(147_483_647)), false);
});

test("保留时长：整数小时，0 关闭，空值回默认，越界夹住", () => {
  assert.equal(DEFAULT_RULE_SWITCH_BRIDGE_HOURS, 1);
  assert.equal(normalizeRuleSwitchBridgeHours(null), 1);
  assert.equal(normalizeRuleSwitchBridgeHours(""), 1);
  assert.equal(normalizeRuleSwitchBridgeHours("abc"), 1);
  assert.equal(normalizeRuleSwitchBridgeHours("0"), 0);
  assert.equal(normalizeRuleSwitchBridgeHours(-3), 0);
  assert.equal(normalizeRuleSwitchBridgeHours("168"), 168);
  assert.equal(normalizeRuleSwitchBridgeHours(2.9), 2);
  assert.equal(normalizeRuleSwitchBridgeHours(99_999), MAX_RULE_SWITCH_BRIDGE_HOURS);
});

test("换入口时只在旧的、新的不包含的监听主机上留桥接", () => {
  assert.deepEqual(entryBridgeHostsForSwitch([1], [2]), [1]);
  assert.deepEqual(entryBridgeHostsForSwitch([1], [1]), []);
  // 入口组：仍在新组里的机器本来就在听
  assert.deepEqual(entryBridgeHostsForSwitch([1, 5, 6], [2, 5]), [1, 6]);
  assert.deepEqual(entryBridgeHostsForSwitch([1, 1, 0, -2], [2]), [1]);
});

test("剩余时间和端口占用报错", () => {
  const now = Date.UTC(2026, 8, 29, 12, 0, 0);
  assert.equal(describeEntryBridgeRemaining(now + 30_000, now), "1 分钟内");
  assert.equal(describeEntryBridgeRemaining(now + 45 * 60_000, now), "约 45 分钟");
  assert.equal(describeEntryBridgeRemaining(now + 60 * 60_000, now), "1 小时");
  assert.equal(describeEntryBridgeRemaining(now + 80 * 60_000, now), "1 小时 20 分钟");
  assert.equal(describeEntryBridgeRemaining(now + 7 * 24 * 3600_000, now), "约 7 天");
  assert.equal(
    entryBridgePortConflictMessage({ port: 40981, ruleId: 10, expiresAtMs: now + 45 * 60_000, nowMs: now }),
    "端口 40981 正被规则 #10 换隧道后的临时桥接占用，约 45 分钟后自动释放",
  );
  assert.equal(
    entryBridgePortConflictMessage({ port: 40981, ruleId: 10, expiresAtMs: now + 10_000, nowMs: now }),
    "端口 40981 正被规则 #10 换隧道后的临时桥接占用，1 分钟内自动释放",
  );
});

test("卡片小字按本地时间写到期点，没有主机名时用编号", () => {
  const expiresAt = new Date(2026, 8, 30, 15, 0, 0);
  assert.equal(formatEntryBridgeNote({ hostName: "Po0", hostId: 1, expiresAt }), "旧入口 Po0 仍在转发（桥接至 09-30 15:00）");
  assert.equal(formatEntryBridgeNote({ hostName: null, hostId: 7, expiresAt: expiresAt.toISOString() }), "旧入口 主机 #7 仍在转发（桥接至 09-30 15:00）");
  assert.equal(formatEntryBridgeNote({ hostName: "Po0", expiresAt: "not-a-date" }), "旧入口 Po0 仍在转发");
});
