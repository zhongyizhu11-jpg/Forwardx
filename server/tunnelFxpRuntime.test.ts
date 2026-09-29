import assert from "node:assert/strict";
import test from "node:test";

import { isAgentUpgradeCompleted, isHostAgentUpgradeUnnecessary, normalizeReportedFxpVersion } from "./agentRouteUtils";
import { filterTunnelFieldsForUser } from "./linkAccessView";
import { tunnelFxpMemberHostIds, tunnelFxpRuntimeIssues, tunnelFxpRuntimeIssueSummary } from "./tunnelFxpRuntime";
import { AGENT_VERSION, FXP_RUNTIME_VERSION } from "../shared/versions";

const hosts = new Map<number, any>([
  [1, { id: 1, name: "Po0", fxpVersion: FXP_RUNTIME_VERSION }],
  [2, { id: 2, name: "Po01", fxpVersion: "2.2.120" }],
  [3, { id: 3, name: "Jinx", fxpVersion: FXP_RUNTIME_VERSION }],
  [4, { id: 4, name: "Relay", fxpVersion: "missing" }],
  [5, { id: 5, name: "Old", fxpVersion: "legacy" }],
]);

test("NEX 隧道：入口、中转、出口、负载均衡出口里握不上的都列出来，每台只列一次", () => {
  const tunnel = { id: 7, mode: "forwardx", entryHostId: 2, exitHostId: 3 };
  const members = tunnelFxpMemberHostIds(tunnel, { hopHostIds: [2, 4, 3], extraExitHostIds: [5], groupHostIds: [] });
  const issues = tunnelFxpRuntimeIssues(tunnel, members, hosts);
  assert.deepEqual(issues.map((issue) => issue.hostId), [2, 4], "能握手的旧版本（legacy）不报警");
  assert.equal(issues[0].message, "Po01 的 FXP 版本过旧（2.2.120），需要升级 Agent");
  assert.match(issues[1].message, /Relay 没有安装 FXP/);
  assert.match(tunnelFxpRuntimeIssueSummary(issues), /^Po01 的 FXP 版本过旧（2\.2\.120），需要升级 Agent；Relay 没有安装 FXP.*流量会超时。$/);
});

test("不是 NEX 的隧道不查 FXP", () => {
  assert.deepEqual(tunnelFxpRuntimeIssues({ mode: "tls", entryHostId: 2, exitHostId: 3 }, [2, 3], hosts), []);
  assert.equal(tunnelFxpRuntimeIssueSummary([]), "");
});

test("共享隧道给别人用时：看不到的主机不报名字和版本，但仍然告诉他隧道有问题", () => {
  const tunnel = {
    id: 7,
    mode: "forwardx",
    entryHostId: 2,
    exitHostId: 3,
    fxpIssues: [
      { hostId: 2, hostName: "Po01", fxpVersion: "2.2.120", message: "Po01 的 FXP 版本过旧（2.2.120），需要升级 Agent" },
    ],
  };
  const scope = { hostIds: new Set([3]), tunnelIds: new Set([7]), groupIds: new Set<number>() };
  const hidden = filterTunnelFieldsForUser(tunnel, scope).fxpIssues;
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].hostId, null);
  assert.equal(hidden[0].hostName, null);
  assert.equal(hidden[0].fxpVersion, null);
  assert.doesNotMatch(hidden[0].message, /Po01|2\.2\.120/);

  const visible = filterTunnelFieldsForUser(tunnel, { ...scope, hostIds: new Set([2, 3]) }).fxpIssues;
  assert.equal(visible[0].message, tunnel.fxpIssues[0].message);
});

test("升级完成要 Agent 到版本、FXP 也不再需要重装；回滚只看 Agent 版本", () => {
  assert.equal(isAgentUpgradeCompleted({ agentVersion: AGENT_VERSION, fxpVersion: FXP_RUNTIME_VERSION }, AGENT_VERSION, AGENT_VERSION), true);
  assert.equal(isAgentUpgradeCompleted({ agentVersion: AGENT_VERSION, fxpVersion: "legacy-v2" }, AGENT_VERSION, AGENT_VERSION), false);
  // 早于 2.2.205 的 Agent 不报 FXP 版本：升到它自己的目标版本就算完成，不能被 FXP 卡住。
  assert.equal(isAgentUpgradeCompleted({ agentVersion: "2.2.204", fxpVersion: null }, "2.2.204", "2.2.204"), true, "旧 Agent 不报 FXP，不能卡住升级");
  // 2.2.205 起必须报：到了版本却没报，说明 FXP 没装好，不算完成。
  assert.equal(isAgentUpgradeCompleted({ agentVersion: "2.2.205", fxpVersion: null }, "2.2.205", "2.2.205"), false);
  assert.equal(isAgentUpgradeCompleted({ agentVersion: "2.2.100", fxpVersion: FXP_RUNTIME_VERSION }, AGENT_VERSION, AGENT_VERSION), false);
  assert.equal(isAgentUpgradeCompleted({ agentVersion: "2.2.100", fxpVersion: "legacy-v2" }, "2.2.100", AGENT_VERSION), true);

  assert.equal(isHostAgentUpgradeUnnecessary({ agentVersion: AGENT_VERSION, fxpVersion: FXP_RUNTIME_VERSION }, AGENT_VERSION, AGENT_VERSION), true);
  assert.equal(isHostAgentUpgradeUnnecessary({ agentVersion: AGENT_VERSION, fxpVersion: "missing" }, AGENT_VERSION, AGENT_VERSION), false);
  assert.equal(isHostAgentUpgradeUnnecessary({ agentVersion: "2.2.100", fxpVersion: FXP_RUNTIME_VERSION }, AGENT_VERSION, AGENT_VERSION), false);
  assert.equal(isHostAgentUpgradeUnnecessary({ agentVersion: "", fxpVersion: FXP_RUNTIME_VERSION }, AGENT_VERSION, AGENT_VERSION), false);
});

test("主机上报的 fxpVersion 只收认识的取值", () => {
  assert.equal(normalizeReportedFxpVersion("2.2.123"), "2.2.123");
  assert.equal(normalizeReportedFxpVersion(" v2.2.124 "), "2.2.124");
  for (const value of ["legacy", "legacy-v2", "missing"]) assert.equal(normalizeReportedFxpVersion(value), value);
  // unknown：Agent 这次没问出来，不能盖掉上次问到的版本。
  for (const value of ["unknown", "", null, undefined, "2.2", "2.2.1; rm -rf /", "<script>", 42]) assert.equal(normalizeReportedFxpVersion(value), "");
});
