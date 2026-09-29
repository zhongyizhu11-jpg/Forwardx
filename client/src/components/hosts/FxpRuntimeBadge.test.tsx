import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AGENT_VERSION, FXP_RUNTIME_VERSION } from "@shared/versions";
import { TunnelFxpIssueNotice, tunnelFxpIssueText } from "@/features/links/TunnelFxpIssueNotice";
import { FxpRuntimeBadge, fxpRuntimeDetailText } from "./FxpRuntimeBadge";

/*
  Agent 版本是新的、FXP 却是握手 v2 的旧版本：主机卡上以前和正常机器一模一样。
*/

test("FXP 正常时不挂角标", () => {
  assert.equal(renderToStaticMarkup(<FxpRuntimeBadge host={{ name: "Jinx", agentVersion: AGENT_VERSION, fxpVersion: FXP_RUNTIME_VERSION }} />), "");
  assert.equal(renderToStaticMarkup(<FxpRuntimeBadge host={{ name: "Old", agentVersion: "2.2.100", fxpVersion: null }} />), "", "不报 FXP 的旧 Agent 靠 Agent 版本提示升级");
  assert.equal(fxpRuntimeDetailText({ fxpVersion: FXP_RUNTIME_VERSION }), `v${FXP_RUNTIME_VERSION}`);
});

test("握不上的标红，写清是哪台、什么版本", () => {
  const html = renderToStaticMarkup(<FxpRuntimeBadge host={{ name: "Po01", agentVersion: AGENT_VERSION, fxpVersion: "2.2.120" }} />);
  assert.match(html, />FXP 过旧</);
  assert.match(html, /text-destructive/);
  assert.match(html, /title="Po01 的 FXP 版本过旧（2\.2\.120），需要升级 Agent"/);
  assert.equal(fxpRuntimeDetailText({ fxpVersion: "2.2.120" }), "v2.2.120（过旧，需升级）");
  assert.match(renderToStaticMarkup(<FxpRuntimeBadge host={{ name: "Po01", agentVersion: AGENT_VERSION, fxpVersion: "missing" }} />), />缺 FXP</);
});

test("还能握手、只是旧了的标黄", () => {
  const html = renderToStaticMarkup(<FxpRuntimeBadge host={{ name: "Po0", agentVersion: AGENT_VERSION, fxpVersion: "legacy" }} />);
  assert.match(html, />FXP 可升级</);
  assert.match(html, /fx-warn-text/);
  assert.match(html, new RegExp(`面板随附 ${FXP_RUNTIME_VERSION.replace(/\./g, "\\.")}`));
});

test("隧道和规则上的提示用面板给的 fxpIssues", () => {
  const tunnel = { fxpIssues: [
    { hostId: 2, message: "Po01 的 FXP 版本过旧（2.2.120），需要升级 Agent" },
    { hostId: 2, message: "Po01 的 FXP 版本过旧（2.2.120），需要升级 Agent" },
  ] };
  assert.equal(tunnelFxpIssueText(tunnel), "Po01 的 FXP 版本过旧（2.2.120），需要升级 Agent");
  assert.match(renderToStaticMarkup(<TunnelFxpIssueNotice tunnel={tunnel} />), /<p[^>]*text-destructive[^>]*>Po01 的 FXP 版本过旧/);
  assert.equal(renderToStaticMarkup(<TunnelFxpIssueNotice tunnel={{ fxpIssues: [] }} />), "");
  assert.equal(renderToStaticMarkup(<TunnelFxpIssueNotice tunnel={null} />), "");
});
