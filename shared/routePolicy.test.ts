import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  describeRoutePolicy,
  describeRoutePolicyReport,
  formatPolicyDuration,
  type RoutePolicyRule,
} from "./routePolicy";

// 2026-09-22 是星期二。上海 20:00 在「工作日 18:00–01:00」里，上海 10:00 不在。
const IN_WINDOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const OUT_OF_WINDOW = Date.UTC(2026, 8, 22, 2, 0, 0);
const HOUR = 3_600_000;
const TZ = "Asia/Shanghai";
const current = { isOnline: true, agentVersion: "2.2.197" };
const eventOnly = { isOnline: true, agentVersion: "2.2.196" };

const schedule = { timezone: TZ, windows: [{ days: [1, 2, 3, 4, 5], from: "18:00", to: "01:00", targetIndex: 1 }] };
const rule = (patch: Partial<Record<keyof RoutePolicyRule, unknown>> = {}): RoutePolicyRule => ({
  failoverEnabled: true,
  failoverStrategy: "fallback",
  targetIp: "198.51.100.7",
  targetPort: 443,
  failoverTargets: JSON.stringify([{ targetIp: "198.51.100.8", targetPort: 443 }, { targetIp: "198.51.100.9", targetPort: 443 }]),
  failoverSeconds: 60,
  recoverSeconds: 120,
  autoFailback: true,
  ...patch,
});
const policyAt = (nowMs: number, patch: Parameters<typeof rule>[0] = {}, host: any = current) =>
  describeRoutePolicy(rule(patch), { host, nowMs, timeZone: TZ })!;
const states = (policy: ReturnType<typeof policyAt>) => policy.conditions.map((condition) => `${condition.kind}:${condition.state}`);

test("没开主备就没有策略", () => {
  assert.equal(describeRoutePolicy(rule({ failoverEnabled: false }), { host: current, nowMs: IN_WINDOW }), null);
});

test("什么都没配：出站顺序在决定，首选主出站", () => {
  const policy = policyAt(IN_WINDOW);
  assert.deepEqual(states(policy), ["order:deciding"]);
  assert.equal(policy.conditions[0].when, "按顺序");
  assert.equal(policy.conditions[0].then, "主出站 → 备用 1 → 备用 2");
  assert.equal(policy.preferredIndex, 0);
  assert.deepEqual(policy.lines.map((line) => line.preferred), [true, false, false]);
});

test("时段内，高亮的是时段表那一行；时段外，退回出站顺序", () => {
  const inside = policyAt(IN_WINDOW, { failoverSchedule: JSON.stringify(schedule) });
  assert.deepEqual(states(inside), ["schedule:deciding", "order:idle"]);
  assert.equal(inside.conditions[0].when, "工作日 18:00–01:00（次日）");
  assert.equal(inside.conditions[0].then, "首选 备用 1");
  assert.equal(inside.conditions[1].when, "其余时候");
  assert.equal(inside.preferredIndex, 1);

  const outside = policyAt(OUT_OF_WINDOW, { failoverSchedule: JSON.stringify(schedule) });
  assert.deepEqual(states(outside), ["schedule:idle", "order:deciding"]);
  assert.equal(outside.preferredIndex, 0);
});

test("钉着的时候，时段表命中了也不算数 —— 那一行标成「被压着」，不是「不适用」", () => {
  /*
    两种状态要分开：「不在时段内」是这一行本来就没轮到；「在时段内但被钉子压着」是
    钉子一到期它就会接手。后者正是用户最该知道的 —— 应急钉完忘了关，时段表就一直
    被压着。
  */
  const policy = policyAt(IN_WINDOW, {
    failoverSchedule: JSON.stringify(schedule),
    failoverPinnedIndex: 2,
    failoverPinnedUntil: new Date(IN_WINDOW + HOUR),
  });
  assert.deepEqual(states(policy), ["pin:deciding", "schedule:overridden", "order:idle"]);
  assert.equal(policy.conditions[0].when, "人工指定，到 21:00");
  assert.equal(policy.conditions[0].then, "强制走 备用 2");
  assert.equal(policy.preferredIndex, 2);
});

test("过期的钉子不出现在策略里", () => {
  const policy = policyAt(OUT_OF_WINDOW, { failoverPinnedIndex: 1, failoverPinnedUntil: new Date(OUT_OF_WINDOW - HOUR) });
  assert.equal(policy.pin, null);
  assert.deepEqual(states(policy), ["order:deciding"]);
});

test("自动择优在决定时，首选交给 Agent —— 面板不知道谁更快，不猜", () => {
  const outside = policyAt(OUT_OF_WINDOW, { failoverPreferFastest: true, failoverSchedule: JSON.stringify(schedule) });
  assert.deepEqual(states(outside), ["schedule:idle", "fastest:deciding", "order:idle"]);
  assert.equal(outside.preferredIndex, null);
  assert.deepEqual(outside.lines.map((line) => line.preferred), [false, false, false]);

  const inside = policyAt(IN_WINDOW, { failoverPreferFastest: true, failoverSchedule: JSON.stringify(schedule) });
  assert.deepEqual(states(inside), ["schedule:deciding", "fastest:overridden", "order:idle"], "时段表压过自动择优");
});

test("择优的门槛写的是 Agent 里那三个数", () => {
  // 文案里照抄了 Agent 的常数。Agent 那边改了、这里没跟上，界面就在说一套机器上不存在的规矩。
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../agent/main.go"), "utf8");
  const constant = (name: string) => Number(source.match(new RegExp(`const ${name} = ([\\d.]+)`))?.[1]);
  const then = policyAt(OUT_OF_WINDOW, { failoverPreferFastest: true }).conditions[0].then;
  assert.match(then, new RegExp(`快 ${constant("failoverFastestMarginMs")}ms`));
  assert.match(then, new RegExp(`快 ${Math.round(constant("failoverFastestMarginRatio") * 100)}%`));
  assert.match(then, new RegExp(`连续 ${constant("failoverFastestHoldSeconds") / 60} 分钟`));
});

test("Agent 早于 2.2.196：人工指定、时段表、自动择优它都不认，策略照实说只按顺序走", () => {
  const policy = policyAt(
    IN_WINDOW,
    { failoverSchedule: JSON.stringify(schedule), failoverPinnedIndex: 2, failoverPreferFastest: true },
    { isOnline: true, agentVersion: "2.2.195" },
  );
  assert.equal(policy.report.kind, "unsupported");
  assert.deepEqual(states(policy), ["pin:idle", "schedule:idle", "fastest:idle", "order:deciding"]);
  assert.equal(policy.preferredIndex, 0);
  assert.match(policy.warnings.join(""), /都不认/);
});

test("现在走哪条：新版 Agent 叫「现在」，2.2.196 只能叫「最近一次切换」", () => {
  const reported = { failoverActiveTarget: "198.51.100.8:443", failoverActiveAt: new Date(IN_WINDOW - 2 * HOUR) };
  const fresh = policyAt(IN_WINDOW, reported);
  assert.deepEqual(fresh.report, { kind: "current", index: 1, since: Math.floor((IN_WINDOW - 2 * HOUR) / 1000) });
  assert.equal(describeRoutePolicyReport(fresh, { nowMs: IN_WINDOW, timeZone: TZ }).text, "现在走 备用 1，18:00 起");
  assert.deepEqual(fresh.lines.map((line) => line.active), [false, true, false]);

  const old = policyAt(IN_WINDOW, reported, eventOnly);
  assert.equal(old.report.kind, "lastSwitch");
  const text = describeRoutePolicyReport(old, { nowMs: IN_WINDOW, timeZone: TZ });
  assert.equal(text.text, "最近一次切到 备用 1，18:00 起");
  assert.match(String(text.note), /回到主出站/, "得说清楚这份记录可能已经过时");
});

test("没有记录时不替它说「走主出站」", () => {
  /*
    2.2.196 的记录只来自切换事件，而这一版之前面板会在心跳早退时丢事件 —— 没有记录
    不等于没切过。新版 Agent 没报上来，是还没来得及报。
  */
  assert.equal(policyAt(IN_WINDOW, {}, eventOnly).report.kind, "noSwitch");
  assert.equal(policyAt(IN_WINDOW, {}, current).report.kind, "pending");
  for (const policy of [policyAt(IN_WINDOW, {}, eventOnly), policyAt(IN_WINDOW, {}, current)]) {
    assert.deepEqual(policy.lines.map((line) => line.active), [false, false, false]);
    assert.equal(describeRoutePolicyReport(policy).tone, "muted");
  }
});

test("机器离线就什么都不说；报上来的地址不在清单里就如实说认不出", () => {
  const reported = { failoverActiveTarget: "198.51.100.8:443", failoverActiveAt: new Date(IN_WINDOW) };
  assert.equal(policyAt(IN_WINDOW, reported, { isOnline: false, agentVersion: "2.2.197" }).report.kind, "offline");
  assert.equal(policyAt(IN_WINDOW, reported, null).report.kind, "offline");
  const unlisted = policyAt(IN_WINDOW, { failoverActiveTarget: "203.0.113.9:1" });
  assert.deepEqual(unlisted.report, { kind: "unlisted", target: "203.0.113.9:1" });
  assert.equal(describeRoutePolicyReport(unlisted).tone, "warn");
});

test("颜色看的是「走的是不是首选」，不是「是不是在备用上」", () => {
  const onBackup = { failoverActiveTarget: "198.51.100.8:443", failoverActiveAt: new Date(IN_WINDOW) };
  // 晚上按时段表走备用 1：排好的，不是出事。
  const planned = policyAt(IN_WINDOW, { ...onBackup, failoverSchedule: JSON.stringify(schedule) });
  assert.equal(describeRoutePolicyReport(planned).tone, "normal");
  assert.equal(planned.divergence, null);
  // 白天首选主出站，却在备用 1 上：值得看一眼。
  const unplanned = policyAt(OUT_OF_WINDOW, { ...onBackup, failoverSchedule: JSON.stringify(schedule) });
  assert.equal(describeRoutePolicyReport(unplanned).tone, "deviated");
  // 自动择优在决定时没有首选，走哪条都不算偏。
  assert.equal(describeRoutePolicyReport(policyAt(OUT_OF_WINDOW, { ...onBackup, failoverPreferFastest: true })).tone, "normal");
});

test("没走首选时只说确实可能的原因，不下结论", () => {
  const onBackup = { failoverActiveTarget: "198.51.100.8:443", failoverActiveAt: new Date(OUT_OF_WINDOW) };
  const auto = policyAt(OUT_OF_WINDOW, onBackup);
  assert.equal(auto.divergence, "首选是 主出站，没走它：它可能正挂着、刚恢复还在观察（2 分钟）。");
  const held = policyAt(OUT_OF_WINDOW, { ...onBackup, failoverMinHoldSeconds: 600 });
  assert.match(String(held.divergence), /最短驻留（10 分钟）/);
  const noFailback = policyAt(OUT_OF_WINDOW, { ...onBackup, autoFailback: false });
  assert.equal(noFailback.divergence, "首选是 主出站，但「恢复后切回」关着：备用 1 不出问题就不会换过去。");
});

test("切换条件：挂了就切、切不切回、最短驻留", () => {
  assert.deepEqual(policyAt(IN_WINDOW, { failoverMinHoldSeconds: 600 }).guards.map((guard) => `${guard.label}：${guard.value}`), [
    "挂了就切：探测连续失败 60 秒，或新连接拨不通",
    "切回首选：首选那条恢复后稳定 2 分钟",
    "最短驻留：切过去之后至少走 10 分钟",
  ]);
  assert.deepEqual(policyAt(IN_WINDOW, { autoFailback: false }).guards.map((guard) => guard.label), ["挂了就切", "不切回"]);
});

test("轮询、随机、哈希：只有一行分摊的规矩，没有首选，也不说现在走哪条", () => {
  const reported = { failoverActiveTarget: "198.51.100.8:443", failoverActiveAt: new Date(IN_WINDOW) };
  for (const [strategy, then] of [["round_robin", "轮流走这 3 条"], ["random", "从 3 条里随机挑一条"], ["ip_hash", "按来源 IP 固定分到其中一条"]]) {
    const policy = policyAt(IN_WINDOW, { ...reported, failoverStrategy: strategy, failoverPinnedIndex: 1 });
    assert.deepEqual(policy.conditions.map((condition) => `${condition.when}→${condition.then}`), [`每条新连接→${then}`]);
    assert.equal(policy.preferredIndex, null);
    assert.deepEqual(policy.lines.map((line) => `${line.preferred}/${line.active}`), ["false/false", "false/false", "false/false"]);
    assert.equal(policy.guards.length, 1, "切不切回、最短驻留只对主备有意义");
    assert.equal(describeRoutePolicyReport(policy).text, "每条新连接各走各的，共 3 条");
  }
});

test("时长的说法", () => {
  assert.equal(formatPolicyDuration(90), "90 秒");
  assert.equal(formatPolicyDuration(120), "2 分钟");
  assert.equal(formatPolicyDuration(5400), "90 分钟");
  assert.equal(formatPolicyDuration(7200), "2 小时");
  assert.equal(formatPolicyDuration(9000), "2.5 小时");
});

test("转发方式或协议不支持主备时照实说：配着，但机器上不会走主备", () => {
  assert.deepEqual(policyAt(IN_WINDOW).warnings, [], "gost + TCP（默认）没有这条提示");
  assert.match(policyAt(IN_WINDOW, { protocol: "both" }).warnings.join(""), /不会走主备/);
  assert.match(policyAt(IN_WINDOW, { forwardType: "realm", protocol: "tcp" }).warnings.join(""), /不会走主备/);
});

test("时段表那几行带着配置里的序号：前面有一条失效的，此刻也标在对的那一行上", () => {
  // 第 0 个时段指向不存在的备用 5（比如刚删了那条备用），不算；命中的是第 1 个。
  const policy = policyAt(IN_WINDOW, { failoverSchedule: JSON.stringify({ timezone: TZ, windows: [
    { days: [], from: "00:00", to: "23:59", targetIndex: 5 },
    { days: [1, 2, 3, 4, 5], from: "18:00", to: "01:00", targetIndex: 2 },
  ] }) });
  const deciding = policy.conditions.find((condition) => condition.state === "deciding");
  assert.equal(deciding?.windowIndex, 1);
  assert.equal(deciding?.key, "schedule-1");
  assert.equal(policy.preferredIndex, 2);
});
