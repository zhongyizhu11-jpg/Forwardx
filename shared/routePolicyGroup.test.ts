import assert from "node:assert/strict";
import test from "node:test";

import {
  describeGroupRoutePolicy,
  describeRoutePolicy,
  describeRoutePolicyReport,
  type RoutePolicyGroup,
  type RoutePolicyGroupMember,
} from "./routePolicy";

// 2026-09-22 上海 20:00。
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const MINUTE = 60_000;
const TZ = "Asia/Shanghai";

const member = (id: number, name: string, patch: Partial<RoutePolicyGroupMember> = {}): RoutePolicyGroupMember => ({
  id,
  memberType: "host",
  hostId: id,
  priority: id - 1,
  isEnabled: true,
  healthStatus: "healthy",
  lastLatencyMs: 18,
  failureSince: null,
  healthySince: new Date(NOW - 60 * MINUTE),
  ddnsValue: `203.0.113.${id}`,
  host: { name },
  ...patch,
});

const group = (patch: Partial<Record<keyof RoutePolicyGroup, unknown>> = {}): RoutePolicyGroup => ({
  groupMode: "failover",
  isEnabled: true,
  domain: "hk.example.com",
  recordType: "A",
  failoverSeconds: 60,
  recoverSeconds: 120,
  autoFailback: true,
  activeMemberId: 1,
  lastDdnsAt: new Date(NOW - 2 * 60 * MINUTE),
  templateRuleCount: 2,
  members: [member(1, "HK entry 01"), member(2, "JP entry 02"), member(3, "SG entry 03")],
  ...patch,
});

const policyOf = (patch: Parameters<typeof group>[0] = {}, options: { ddnsSwitching?: boolean } = {}) =>
  describeGroupRoutePolicy(group(patch), { nowMs: NOW, timeZone: TZ, ...options })!;
const reportOf = (policy: ReturnType<typeof policyOf>) => describeRoutePolicyReport(policy, { nowMs: NOW, timeZone: TZ });
const guard = (policy: ReturnType<typeof policyOf>, key: string) => policy.guards.find((item) => item.key === key)?.value;

test("只有故障转移模式的组有策略；规则那边的模型标明自己是规则", () => {
  assert.equal(describeGroupRoutePolicy(group({ groupMode: "chain" }), { nowMs: NOW }), null);
  assert.equal(describeGroupRoutePolicy(group({ groupMode: "entry" }), { nowMs: NOW }), null);
  assert.equal(policyOf().subject, "group");
  const rule = describeRoutePolicy({ failoverEnabled: true, targetIp: "198.51.100.7", targetPort: 443 }, { nowMs: NOW });
  assert.equal(rule?.subject, "rule");
});

test("成员按 priority 排（一样时按 id），首选是第一个启用的 —— 和服务端挑成员一个次序", () => {
  // 故意乱序给：数组顺序是 SG、HK、JP，priority 才是真正的次序。
  const policy = policyOf({
    members: [
      member(3, "SG entry 03", { priority: 1 }),
      member(1, "HK entry 01", { priority: 0, isEnabled: false }),
      member(2, "JP entry 02", { priority: 1 }),
    ],
    activeMemberId: 2,
  });
  assert.deepEqual(policy.lines.map((line) => line.label), ["HK entry 01", "JP entry 02", "SG entry 03"]);
  assert.equal(policy.preferredIndex, 1, "停用的 HK 不算首选");
  assert.deepEqual(policy.lines.map((line) => line.preferred), [false, true, false]);
  assert.equal(policy.conditions[0].then, "JP entry 02 → SG entry 03", "顺序里不列停用的成员");
  assert.equal(policy.lines[0].health, "standby");
  assert.equal(policy.lines[0].note, "已停用");
  assert.deepEqual(policy.lines.map((line) => line.enabled), [false, true, true]);
  assert.deepEqual(policy.lines.map((line) => line.memberId), [1, 2, 3]);
});

test("解析指向谁：说「现在解析到」，时刻只说「最近一次写入」—— 手动同步、重启都会重写，不能说成「起」", () => {
  const policy = policyOf();
  assert.deepEqual(policy.report, { kind: "resolved", index: 0, writtenAt: Math.floor((NOW - 2 * 60 * MINUTE) / 1000) });
  const report = reportOf(policy);
  assert.equal(report.text, "现在解析到 HK entry 01");
  assert.equal(report.note, "最近一次写入解析：18:00");
  assert.equal(report.tone, "normal");
  assert.doesNotMatch(report.text, /起/);
  assert.equal(policy.conditions[0].state, "deciding");
  assert.equal(policy.deciding, "order");
  assert.deepEqual(policy.lines.map((line) => line.active), [true, false, false]);
  assert.equal(policy.lines[0].note, "18ms");
  assert.equal(policy.divergence, null);
  assert.deepEqual(policy.warnings, []);
});

test("系统 DDNS 没开：只是「建议入口」，不染色，「怎么切」写明解析不会改", () => {
  const policy = policyOf({}, { ddnsSwitching: false });
  assert.deepEqual(policy.report, { kind: "suggested", index: 0 });
  const report = reportOf(policy);
  assert.equal(report.text, "建议入口是 HK entry 01");
  assert.equal(report.tone, "muted");
  assert.match(guard(policy, "switch") || "", /系统 DDNS 没开.*hk\.example\.com 的解析不会改/);
  assert.equal(policy.lines[0].active, true, "建议的那个照样标出来");
  // 不知道（设置还没加载）时按开着说。
  assert.equal(describeGroupRoutePolicy(group(), { nowMs: NOW })!.report.kind, "resolved");
});

test("没配域名：只看健康、不切换 —— 条件行不标「此刻」，也没有「挂了就切」「切回」", () => {
  const policy = policyOf({ domain: "" });
  assert.equal(policy.report.kind, "noDomain");
  assert.equal(reportOf(policy).text, "只看成员健康，不切换");
  assert.equal(policy.conditions[0].state, "idle");
  assert.equal(policy.deciding, null);
  assert.deepEqual(policy.guards.map((item) => item.key), ["health", "switch"]);
  assert.ok(policy.lines.every((line) => !line.active), "库里的 activeMemberId 是旧的，不标");
  assert.equal(policy.lines[0].health, "healthy", "健康照样看");
});

test("组停用：不检测、不切换，成员都是待命", () => {
  const policy = policyOf({ isEnabled: false });
  assert.equal(policy.report.kind, "groupDisabled");
  assert.equal(reportOf(policy).text, "转发组停用了：不检测、不切换");
  assert.ok(policy.lines.every((line) => line.health === "standby" && !line.active));
  assert.equal(policy.conditions[0].state, "idle");
  assert.deepEqual(policy.warnings, []);
});

test("还没选出入口（新建、或者一直没有健康的）", () => {
  const policy = policyOf({ activeMemberId: null });
  assert.equal(policy.report.kind, "pending");
  assert.equal(reportOf(policy).text, "还没选出入口");
  // 指向一个已经删掉的成员也一样。
  assert.equal(policyOf({ activeMemberId: 99 }).report.kind, "pending");
});

test("首选不健康：说为什么用的是后面那个，而且标成「没走首选」的颜色", () => {
  const policy = policyOf({
    activeMemberId: 2,
    members: [
      member(1, "HK entry 01", { healthStatus: "unhealthy", failureSince: new Date(NOW - 30 * MINUTE), healthySince: null }),
      member(2, "JP entry 02"),
    ],
  });
  assert.equal(policy.divergence, "首选 HK entry 01 不健康（19:30 起），所以用的是 JP entry 02。");
  assert.equal(policy.lines[0].health, "down");
  assert.equal(policy.lines[0].note, "不健康，19:30 起");
  assert.equal(reportOf(policy).tone, "deviated");
});

test("首选恢复了：还在观察就说还差多久；「恢复后切回」关着就明说不会切回", () => {
  const recovering = (healthySince: Date, autoFailback = true) => policyOf({
    activeMemberId: 2,
    autoFailback,
    members: [member(1, "HK entry 01", { healthySince }), member(2, "JP entry 02")],
  }).divergence;
  assert.equal(recovering(new Date(NOW - 40_000)), "首选 HK entry 01 恢复了 40 秒，最晚满 2 分钟切回。");
  assert.equal(recovering(new Date(NOW - 5 * MINUTE)), "首选 HK entry 01 已经恢复，下一次检查就切回去。");
  assert.equal(recovering(new Date(NOW - 40_000), false), "首选 HK entry 01 已经正常，但「恢复后切回」关着：JP entry 02 不出问题就一直用它。");
});

test("在用的那个不健康：有别的健康成员时说最晚多久换走；一个健康的都没有时交给警告", () => {
  const unhealthyActive = (downFor: number, others = "healthy") => policyOf({
    members: [
      member(1, "HK entry 01", { healthStatus: "unhealthy", failureSince: new Date(NOW - downFor), healthySince: null }),
      member(2, "JP entry 02", { healthStatus: others, failureSince: others === "unhealthy" ? new Date(NOW - MINUTE) : null }),
    ],
  });
  assert.equal(unhealthyActive(20_000).divergence, "在用的 HK entry 01 不健康（19:59 起），最晚满 60 秒换到下一个健康的。");
  assert.equal(unhealthyActive(5 * MINUTE).divergence, "在用的 HK entry 01 不健康（19:55 起），下一次检查就换走。");
  const allDown = unhealthyActive(5 * MINUTE, "unhealthy");
  assert.equal(allDown.divergence, null);
  assert.deepEqual(allDown.warnings, ["眼下没有健康的成员：解析先保持原样，等有成员恢复。"]);
  // 解析指着的就是首选，但它不健康 —— 不能因为「没偏离首选」就标绿。
  assert.equal(reportOf(allDown).tone, "warn");
  assert.equal(reportOf(unhealthyActive(5 * MINUTE, "unknown")).tone, "warn");
  // 有在等检测结果的就不报「没有健康的」：刚起来时全是灰的，不该吓人。
  assert.deepEqual(unhealthyActive(5 * MINUTE, "unknown").warnings, []);
  const waiting = policyOf({ members: [member(1, "HK entry 01", { healthStatus: "unknown" })] });
  assert.equal(waiting.divergence, "在用的 HK entry 01 在等检测结果：解析先不动。");
  assert.equal(reportOf(waiting).tone, "muted");
});

test("什么时候切：写上「Agent 已判定」那半句，秒数和服务端一样最少 10 秒", () => {
  const policy = policyOf({ failoverSeconds: 5, recoverSeconds: 0 });
  assert.equal(guard(policy, "failover"), "在用的成员不健康满 10 秒就换下一个健康的；Agent 已判定失败的不等");
  assert.equal(guard(policy, "recover"), "更靠前的成员恢复了就切回：Agent 判定健康的马上切，否则等它稳定 2 分钟");
  assert.equal(policyOf({ autoFailback: false }).guards.find((item) => item.key === "recover")?.label, "不切回");
  assert.equal(guard(policy, "switch"), "改 hk.example.com 的 A 记录，指向在用成员的地址");
});

test("怎么算健康：开了入口检测就写上方式和目标，目标空着时写默认的那个", () => {
  assert.equal(guard(policyOf(), "health"), "成员上的转发在跑、Agent 探测通过");
  assert.equal(
    guard(policyOf({ chinaHealthCheckEnabled: true, chinaHealthCheckMethod: "ping", chinaHealthCheckTarget: "" }), "health"),
    "成员上的转发在跑、Agent 探测通过，而且从成员上 Ping www.189.cn 能通",
  );
  assert.match(guard(policyOf({ chinaHealthCheckEnabled: true, chinaHealthCheckTarget: "1.2.4.8:443" }), "health") || "", /TCPing 1\.2\.4\.8:443 能通/);
});

test("还没有规则用这个组：不拿库里旧的健康说事，一直挑最前面在线的，不看「恢复后切回」", () => {
  const policy = policyOf({
    templateRuleCount: 0,
    autoFailback: false,
    activeMemberId: 2,
    members: [member(1, "HK entry 01", { healthStatus: "unhealthy" }), member(2, "JP entry 02")],
  });
  assert.ok(policy.lines.every((line) => line.health === "unknown"), "库里那份健康是旧的");
  assert.deepEqual(policy.warnings, ["还没有转发规则用这个组：不探测转发，只看成员机器在不在线。"]);
  assert.equal(policy.divergence, null);
  assert.equal(guard(policy, "recover"), "一直挑排在最前、在线的那个：前面的一上线就换回去");
  assert.match(guard(policy, "health") || "", /^机器在线/);
});

test("成员没有这种记录要的地址：行上写明，不拿别的地址顶上", () => {
  const policy = policyOf({
    recordType: "AAAA",
    members: [member(1, "HK entry 01", { ddnsValue: "2001:db8::1" }), member(2, "JP entry 02", { ddnsValue: "", entryAddress: "203.0.113.2" })],
  });
  assert.equal(policy.lines[0].endpoint, "2001:db8::1");
  assert.equal(policy.lines[1].endpoint, "", "IPv4 不能当 AAAA 的值");
  assert.equal(policy.lines[1].note, "18ms，没有 IPv6 地址");
});

test("停用了还在用的成员：最晚满故障转移时间换走", () => {
  const policy = policyOf({ members: [member(1, "HK entry 01", { isEnabled: false }), member(2, "JP entry 02")] });
  assert.equal(policy.divergence, "在用的 HK entry 01 已经停用，最晚满 60 秒换走。");
  assert.equal(policy.preferredIndex, 1);
});

test("没有成员、成员全停用：各给一句", () => {
  assert.deepEqual(policyOf({ members: [], activeMemberId: null }).warnings, ["还没有成员。"]);
  assert.deepEqual(policyOf({ members: [member(1, "HK entry 01", { isEnabled: false })] }).warnings, ["成员全停用了：没有能用的入口。"]);
  assert.equal(policyOf({ members: [] }).conditions[0].then, "没有启用的成员");
});
