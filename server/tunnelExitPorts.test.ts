import assert from "node:assert/strict";
import test from "node:test";
import { claimTunnelExitReportRequest, hasTunnelExitPort, recordTunnelExitPorts, resetTunnelExitPortsForTest, tunnelExitPortFor } from "./tunnelExitPorts";

/**
 * 出口报的端口怎么记、入口怎么用：入口替出口填的调度器和守卫端口要按出口自己分到的来，
 * 见 server/tunnelExitPorts.ts 顶上的说明。存库、面板重启后读回来在 tunnelExitPortsHeartbeat.test.ts。
 */

const local = { whenRuleMissing: "local" } as const;
const none = { whenRuleMissing: "none" } as const;

test("出口一次都没报过（刚升级，库里也没有）：按入口自己算的填，和升级前一样", async () => {
  await resetTunnelExitPortsForTest();
  assert.equal(tunnelExitPortFor("guard", 7, [1], 39007, local), 39007);
  assert.equal(tunnelExitPortFor("scheduler", 7, [1], 41007, none), 41007);
  assert.equal(hasTunnelExitPort(1, "scheduler", 7), false, "但还是算没报过，入口要催出口来一次心跳");
  assert.equal(tunnelExitPortFor("scheduler", 7, [], 41007, none), 41007, "没有出口（不该发生）也不出错");
});

test("出口报过、但没有这条规则（规则刚建）：调度器返回 null（调用方拨路径 A），守卫按入口算的", async () => {
  await resetTunnelExitPortsForTest();
  recordTunnelExitPorts(1, [{ ruleId: 8, kind: "scheduler", port: 41008, entryHostIds: [2] }]);
  assert.equal(tunnelExitPortFor("scheduler", 7, [1], 41007, none), null);
  assert.equal(tunnelExitPortFor("guard", 7, [1], 39007, local), 39007);
  recordTunnelExitPorts(3, []);
  assert.equal(tunnelExitPortFor("scheduler", 7, [3], 41007, none), null, "报了个空表也算报过");
});

test("出口报了自己分到的端口：入口按出口的填", async () => {
  await resetTunnelExitPortsForTest();
  recordTunnelExitPorts(1, [{ ruleId: 7, kind: "scheduler", port: 41008, entryHostIds: [2] }]);
  assert.equal(hasTunnelExitPort(1, "scheduler", 7), true);
  assert.equal(tunnelExitPortFor("scheduler", 7, [1], 41007, none), 41008);
  assert.equal(tunnelExitPortFor("guard", 7, [1], 39007, local), 39007, "调度器和守卫分开记");
  assert.equal(tunnelExitPortFor("scheduler", 8, [1], 41008, none), null, "别的规则还没报");
  assert.equal(tunnelExitPortFor("scheduler", 7, [9], 41007, none), 41007, "别的出口没报过，按入口算的");
});

test("几个出口：报的一样就用它，不一样返回 null；报过但没有这条规则的出口按 whenRuleMissing 算", async () => {
  await resetTunnelExitPortsForTest();
  recordTunnelExitPorts(1, [{ ruleId: 7, kind: "scheduler", port: 41008, entryHostIds: [2] }]);
  recordTunnelExitPorts(4, [{ ruleId: 7, kind: "scheduler", port: 41008, entryHostIds: [2] }]);
  assert.equal(tunnelExitPortFor("scheduler", 7, [1, 4], 41007, none), 41008);
  recordTunnelExitPorts(4, [{ ruleId: 7, kind: "scheduler", port: 41009, entryHostIds: [2] }]);
  assert.equal(tunnelExitPortFor("scheduler", 7, [1, 4], 41007, none), null);
  recordTunnelExitPorts(5, []);
  assert.equal(tunnelExitPortFor("scheduler", 7, [1, 5], 41008, none), null, "5 号报过、但没有这条规则");
  assert.equal(tunnelExitPortFor("scheduler", 7, [1, 5], 41007, local), null, "5 号按入口算的 41007，和 1 号的 41008 对不上");
  assert.equal(tunnelExitPortFor("scheduler", 7, [1, 5], 41008, local), 41008);
});

test("入口自己也是出口时，它那份按这次本机算的", async () => {
  await resetTunnelExitPortsForTest();
  recordTunnelExitPorts(2, [{ ruleId: 7, kind: "scheduler", port: 41009, entryHostIds: [2] }]);
  assert.equal(tunnelExitPortFor("scheduler", 7, [2], 41007, { selfHostId: 2, whenRuleMissing: "none" }), 41007, "上一次记的是旧的，这次本机算的才是真的");
});

test("端口有变化才推入口：新报、改了、不再报都推，没变不推，不推出口自己", async () => {
  await resetTunnelExitPortsForTest();
  assert.deepEqual(recordTunnelExitPorts(1, [
    { ruleId: 7, kind: "scheduler", port: 41007, entryHostIds: [2, 6] },
    { ruleId: 8, kind: "guard", port: 39008, entryHostIds: [3, 1] },
  ]), [2, 3, 6], "第一次报：入口都推一次");
  assert.deepEqual(recordTunnelExitPorts(1, [
    { ruleId: 8, kind: "guard", port: 39008, entryHostIds: [3, 1] },
    { ruleId: 7, kind: "scheduler", port: 41007, entryHostIds: [6, 2] },
  ]), [], "没变（顺序不同也算没变）");
  assert.deepEqual(recordTunnelExitPorts(1, [
    { ruleId: 7, kind: "scheduler", port: 41010, entryHostIds: [2, 6] },
    { ruleId: 8, kind: "guard", port: 39008, entryHostIds: [3, 1] },
  ]), [2, 6], "7 号的端口改了");
  assert.deepEqual(recordTunnelExitPorts(1, [
    { ruleId: 8, kind: "guard", port: 39008, entryHostIds: [3, 1] },
  ]), [2, 6], "7 号不再报（出口不跑它的调度器了）");
  assert.equal(tunnelExitPortFor("scheduler", 7, [1], 41007, none), null, "不再报：出口报过、但没有这条规则");
});

test("不像样的上报不记", async () => {
  await resetTunnelExitPortsForTest();
  assert.deepEqual(recordTunnelExitPorts(0, [{ ruleId: 7, kind: "scheduler", port: 41007, entryHostIds: [2] }]), []);
  assert.deepEqual(recordTunnelExitPorts(1, [
    { ruleId: 0, kind: "scheduler", port: 41007, entryHostIds: [2] },
    { ruleId: 7, kind: "scheduler", port: 70000, entryHostIds: [2] },
    { ruleId: 7, kind: "other" as any, port: 41007, entryHostIds: [2] },
  ]), []);
  assert.equal(hasTunnelExitPort(1, "scheduler", 7), false);
});

test("催出口来心跳：同一台一分钟最多一次", async () => {
  await resetTunnelExitPortsForTest();
  assert.equal(claimTunnelExitReportRequest(1, 1_000_000), true);
  assert.equal(claimTunnelExitReportRequest(1, 1_030_000), false, "30 秒后不再催");
  assert.equal(claimTunnelExitReportRequest(4, 1_030_000), true, "别的出口不受影响");
  assert.equal(claimTunnelExitReportRequest(1, 1_060_000), true, "一分钟后可以再催");
  assert.equal(claimTunnelExitReportRequest(0, 1_060_000), false);
});
