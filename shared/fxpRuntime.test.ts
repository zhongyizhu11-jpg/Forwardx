import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_FXP_VERSION_REPORT_VERSION,
  fxpRuntimeIncompatible,
  fxpRuntimeIssueMessage,
  fxpRuntimeStatus,
  hostNeedsAgentUpgrade,
} from "./fxpRuntime";
import { compareVersions } from "./version";
import { AGENT_VERSION, FXP_MIN_WIRE_VERSION, FXP_RUNTIME_VERSION } from "./versions";

/*
  用户那台：所有主机都报 Agent 2.2.20x，可有一台的 FXP 是升级脚本下载失败后留下的握手 v2
  旧版本。面板只看 Agent 版本，认为它是最新的、不给升级；隧道能 tcping、流量全超时。
*/

test("当前版本的 FXP 正常", () => {
  const status = fxpRuntimeStatus({ agentVersion: AGENT_VERSION, fxpVersion: FXP_RUNTIME_VERSION });
  assert.equal(status.state, "ok");
  assert.equal(status.needsUpgrade, false);
  assert.equal(status.wireCompatible, true);
  assert.equal(fxpRuntimeStatus({ fxpVersion: `v${FXP_RUNTIME_VERSION}` }).state, "ok", "v 前缀要容忍");
});

test("握手 v2 的旧 FXP：握不上、要升级，即使 Agent 已是最新", () => {
  for (const fxpVersion of ["legacy-v2", "2.2.120", "2.1.9"]) {
    const host = { agentVersion: AGENT_VERSION, fxpVersion };
    const status = fxpRuntimeStatus(host);
    assert.equal(status.state, "incompatible", fxpVersion);
    assert.equal(status.wireCompatible, false, fxpVersion);
    assert.equal(hostNeedsAgentUpgrade(host, AGENT_VERSION), true, `${fxpVersion} 要算进「可升级」`);
    assert.equal(fxpRuntimeIncompatible(host), true);
  }
  assert.equal(
    fxpRuntimeIssueMessage("Po01", { fxpVersion: "2.2.120" }),
    "Po01 的 FXP 版本过旧（2.2.120），需要升级 Agent",
  );
  assert.match(fxpRuntimeIssueMessage("Po01", { fxpVersion: "legacy-v2" }), new RegExp(`Po01 的 FXP 版本过旧（早于 ${FXP_MIN_WIRE_VERSION.replace(/\./g, "\\.")}）`));
});

test("能握手但比面板带的旧：可升级，不报警", () => {
  const host = { agentVersion: AGENT_VERSION, fxpVersion: "legacy" };
  assert.equal(fxpRuntimeStatus(host).state, "outdated");
  assert.equal(fxpRuntimeStatus(host).wireCompatible, true);
  assert.equal(hostNeedsAgentUpgrade(host, AGENT_VERSION), true);
  assert.equal(fxpRuntimeIssueMessage("Po01", host), "", "能握手的旧版本不在隧道上报警");
  assert.equal(fxpRuntimeStatus({ fxpVersion: FXP_MIN_WIRE_VERSION }).wireCompatible, true);
  if (compareVersions(FXP_MIN_WIRE_VERSION, FXP_RUNTIME_VERSION) < 0) {
    assert.equal(fxpRuntimeStatus({ fxpVersion: FXP_MIN_WIRE_VERSION }).state, "outdated");
  }
});

test("没装 FXP：握不上、要升级", () => {
  const host = { agentVersion: AGENT_VERSION, fxpVersion: "missing" };
  assert.equal(fxpRuntimeStatus(host).state, "missing");
  assert.equal(hostNeedsAgentUpgrade(host, AGENT_VERSION), true);
  assert.match(fxpRuntimeIssueMessage("Jinx", host), /Jinx 没有安装 FXP/);
});

test("没报 fxpVersion：只有会报的 Agent 才算问题", () => {
  const oldAgent = { agentVersion: "2.2.204", fxpVersion: null };
  assert.equal(fxpRuntimeStatus(oldAgent).state, "unknown");
  assert.equal(fxpRuntimeStatus(oldAgent).needsUpgrade, false, "旧 Agent 不报是正常的，靠 Agent 版本判断升级");
  assert.equal(hostNeedsAgentUpgrade(oldAgent, "2.2.204"), false);

  const newAgent = { agentVersion: AGENT_FXP_VERSION_REPORT_VERSION, fxpVersion: "" };
  assert.equal(fxpRuntimeStatus(newAgent).state, "unreported");
  assert.equal(hostNeedsAgentUpgrade(newAgent, AGENT_FXP_VERSION_REPORT_VERSION), true);
  assert.equal(fxpRuntimeIncompatible(newAgent), false, "说不准的不在隧道上报警");

  assert.equal(fxpRuntimeStatus({ agentVersion: AGENT_VERSION, fxpVersion: "unknown" }).needsUpgrade, false);
});

test("Agent 落后照旧算可升级；没上报 Agent 版本的不算", () => {
  assert.equal(hostNeedsAgentUpgrade({ agentVersion: "2.2.100", fxpVersion: FXP_RUNTIME_VERSION }, AGENT_VERSION), true);
  assert.equal(hostNeedsAgentUpgrade({ agentVersion: AGENT_VERSION, fxpVersion: FXP_RUNTIME_VERSION }, AGENT_VERSION), false);
  assert.equal(hostNeedsAgentUpgrade({ agentVersion: "", fxpVersion: "legacy-v2" }, AGENT_VERSION), false);
});
