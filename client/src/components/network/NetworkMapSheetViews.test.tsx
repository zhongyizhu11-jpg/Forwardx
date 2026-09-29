import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { buildNetworkMapAlerts } from "@/features/network/networkMapAlerts";
import { buildNetworkMapModel } from "@/features/network/networkMapModel";
import { summarizeLatencySeries } from "@/features/network/networkMapSeries";

import { LinkDetailView, NodeDetailView, OverviewView, SheetHead, TargetDetailView, hostRole, linkHeadTitle, linkIssueText, nodeHeadSubtitle } from "./NetworkMapSheetViews";

const now = 1_700_000_000_000;
const model = buildNetworkMapModel({
  now,
  hosts: [
    { id: 1, name: "Po0", isOnline: true, lastHeartbeat: now - 3000, ipv4: "42.194.198.67", agentVersion: "2.2.205", fxpVersion: "2.2.124", geoCountryCode: "CN", geoRegion: "广州", geoLatitudeMicro: 23_129_000, geoLongitudeMicro: 113_264_000, memoryTotal: 4 * 1024 ** 3 },
    { id: 3, name: "Jinx", isOnline: true, lastHeartbeat: now - 3000, ipv4: "103.152.220.41", agentVersion: "2.2.205", fxpVersion: "2.2.124", geoCountryCode: "HK", geoRegion: "香港", geoLatitudeMicro: 22_319_000, geoLongitudeMicro: 114_169_000 },
    { id: 5, name: "NoGeo", isOnline: false, lastHeartbeat: now - 30 * 60_000, geoCountryCode: "TW" },
  ],
  tunnels: [
    { id: 11, name: "华南-香港", mode: "forwardx", forwardxVersion: "v1", isEnabled: true, entryHostId: 1, exitHostId: 3, lastLatencyMs: 7, availability: { status: "available", message: "最近一次探测可达（7ms）" } },
    { id: 12, name: "旧线", mode: "tls", isEnabled: true, entryHostId: 1, exitHostId: 3, lastLatencyMs: 234, availability: { status: "degraded", message: "部分节点不可用" }, fxpIssues: [{ message: "出口 Jinx 的 FXP 版本过旧" }] },
  ],
  rules: [
    { id: 21, name: "广港us", hostId: 1, tunnelId: 11, sourcePort: 40981, targetIp: "zzy.example.xyz", targetPort: 19001, protocol: "tcp", isEnabled: true, isRunning: true },
    { id: 22, name: "直连", hostId: 3, tunnelId: null, sourcePort: 5000, targetIp: "1.1.1.1", targetPort: 53, protocol: "udp", isEnabled: false, isRunning: false },
  ],
  targetGeo: [{ target: "zzy.example.xyz", geo: { latitude: 34.05, longitude: -118.24, countryCode: "US", region: "洛杉矶" } }],
});
const noop = () => undefined;

test("总览：告警、隧道、主机、未定位都列出来，隐藏一端的线有说明", () => {
  const alerts = buildNetworkMapAlerts(model, now);
  const html = renderToStaticMarkup(<OverviewView model={model} alerts={alerts} onAlert={noop} onOpenNode={noop} onOpenLink={noop} baseLayerAmap />);
  assert.match(html, /需要关注/);
  assert.match(html, /NoGeo 离线/);
  assert.match(html, /旧线：FXP 版本过旧/);
  assert.match(html, /nm-alert error/);
  assert.match(html, /华南-香港 <span class="nm-pill mono">NEX V1<\/span>/);
  assert.match(html, /Po0 → Jinx/);
  assert.match(html, /7 ms/);
  assert.match(html, /未定位/);
  assert.match(html, /高德地图（GCJ-02/);
  assert.doesNotMatch(html, /nm-empty/);
});

test("节点：版本、IP、角色、内存条和三个快捷操作；Agent 最新时升级按钮禁用", () => {
  const node = model.nodes.find((item) => item.id === 1)!;
  assert.equal(hostRole(model, 1), "入口");
  assert.equal(hostRole(model, 3), "入口 · 出口");
  assert.equal(nodeHeadSubtitle(node, model), "广州 · 入口 · Agent 2.2.205 · FXP v2.2.124");
  const vitals = { cpuSeries: [10, 20], netInSeries: [1000, 2000], netOutSeries: [500, 600], cpuNow: 20, memoryPercent: 40, memoryUsed: 1.6 * 1024 ** 3, diskPercent: 35, diskUsed: 21 * 1024 ** 3, diskTotal: 60 * 1024 ** 3, netInNow: 181e6 / 8, netOutNow: 176e6 / 8, uptimeSeconds: 37 * 86_400 + 4 * 3_600, sampleCount: 2 };
  const html = renderToStaticMarkup(
    <NodeDetailView model={model} node={node} vitals={vitals} vitalsLoading={false} memoryTotal={node.memoryTotal} now={now} onUpgrade={null} upgrading={false} onNetworkTest={noop} onHostDetail={noop} onOpenLink={noop} onCopy={noop} />,
  );
  assert.match(html, /42\.194\.198\.67/);
  assert.match(html, /37 天 4 小时/);
  assert.match(html, /心跳正常 · 刚刚/);
  assert.match(html, /aria-valuenow="40"/);
  assert.match(html, /181\.0 Mbps/);
  assert.match(html, /:40981 → zzy\.example\.xyz:19001 · 华南-香港/);
  assert.match(html, /网络测试/);
  assert.match(html, /disabled="" title="Agent 已是最新"/);
  assert.match(html, /主机详情/);
  assert.doesNotMatch(html, /SSH/);
});

test("链路：标题带国家码，异常一句话，探测成功率不叫丢包率，流量分近 24 小时和累计", () => {
  const link = model.links.find((item) => item.id === 12)!;
  assert.equal(linkHeadTitle(link, model.nodes), "Po0 (CN) → Jinx (HK)");
  assert.equal(linkIssueText(link), "出口 Jinx 的 FXP 版本过旧");
  assert.equal(linkIssueText(model.links.find((item) => item.id === 11)!), null);
  const latency = summarizeLatencySeries([
    { latencyMs: 8, recordedAt: 1, probeCount: 10, probeSuccesses: 10 },
    { latencyMs: null, isTimeout: true, recordedAt: 2, probeCount: 10, probeSuccesses: 2 },
    { latencyMs: 12, recordedAt: 3, probeCount: 10, probeSuccesses: 10 },
  ]);
  const html = renderToStaticMarkup(
    <LinkDetailView model={model} link={link} latency={latency} latencyLoading={false} latencyError={null} traffic={{ day: { bytesIn: 3.9e9, bytesOut: 1.2e9 }, total: { bytesIn: 61.4e9, bytesOut: 18.7e9 } }} onDiagnose={noop} diagnosing={false} onOpenNode={noop} />,
  );
  assert.match(html, /出口 Jinx 的 FXP 版本过旧/);
  assert.match(html, /探测成功率/);
  assert.doesNotMatch(html, /丢包率/);
  assert.match(html, /aria-label="探测成功率 73%"/);
  assert.match(html, /抖动/);
  assert.match(html, /近 24 小时/);
  assert.match(html, /累计/);
  assert.match(html, /还没有规则走这条隧道/, "广港us 走的是 11 号隧道，不在这条上");
  assert.doesNotMatch(html, /本月/);
  assert.match(html, /没有逐跳数据/);
  assert.match(html, /诊断/);
});

test("链路：延迟历史读不到时写出来，不画空图", () => {
  const link = model.links.find((item) => item.id === 11)!;
  const html = renderToStaticMarkup(
    <LinkDetailView model={model} link={link} latency={null} latencyLoading={false} latencyError="看不到这条隧道的延迟历史" traffic={{ day: null, total: null }} onDiagnose={null} diagnosing={false} onOpenNode={noop} />,
  );
  assert.match(html, /看不到这条隧道的延迟历史/);
  assert.match(html, /aria-label="探测成功率 —"/);
});

test("落地目标：指向它的规则和出口主机", () => {
  const target = model.targets.find((item) => item.key === "zzy.example.xyz")!;
  const html = renderToStaticMarkup(<TargetDetailView model={model} target={target} onOpenLink={noop} onOpenNode={noop} />);
  assert.match(html, /指向它的规则/);
  assert.match(html, /广港us/);
  assert.match(html, /:40981 → :19001/);
  assert.match(html, /Jinx/);
  assert.match(html, /只有管理员看得到/);
});

test("抽屉头：有返回时画返回键，没有就不画", () => {
  assert.match(renderToStaticMarkup(<SheetHead onBack={noop} title="x" subtitle="y" />), /aria-label="返回总览"/);
  assert.doesNotMatch(renderToStaticMarkup(<SheetHead title="x" />), /aria-label="返回总览"/);
});
