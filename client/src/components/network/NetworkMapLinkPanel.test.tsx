import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { buildNetworkMapModel } from "@/features/network/networkMapModel";

import { LinkPanelBody, LinkPanelTabs, formatDateTime, lastSwitchAt, linkLandings, linkStatusLabel, type LinkPanelProps } from "./NetworkMapLinkPanel";

const now = 1_700_000_000_000;
const host = (id: number, name: string, region: string, code: string) => ({ id, name, isOnline: true, lastHeartbeat: now - 1000, geoRegion: region, geoCountryCode: code, geoLatitudeMicro: 22e6 + id, geoLongitudeMicro: 114e6 + id });
const model = buildNetworkMapModel({
  now,
  hosts: [host(1, "HK entry", "Hong Kong", "HK"), host(2, "JP relay", "Tokyo", "JP"), host(3, "US exit", "Los Angeles", "US")],
  tunnels: [
    { id: 7, name: "NEX V1", mode: "forwardx", isEnabled: true, entryHostId: 1, exitHostId: 3, hopHostIds: [1, 2, 3], latestLatencyMs: 120, latestLatencyAt: new Date(now - 60_000).toISOString(), createdAt: new Date(2026, 0, 2, 3, 4).toISOString(),
      lastTestMessage: JSON.stringify({ details: [{ fromHostId: 1, toHostId: 2, latencyMs: 31 }, { fromHostId: 2, toHostId: 3, latencyMs: 88 }] }) },
    { id: 8, name: "旧线", mode: "tls", isEnabled: true, entryHostId: 1, exitHostId: 3 },
  ],
  rules: [
    { id: 70, name: "游戏", hostId: 1, tunnelId: 7, targetIp: "203.0.113.5", targetPort: 443, isEnabled: true, isRunning: true, failoverEnabled: true, failoverActiveTarget: "203.0.113.6:443", failoverActiveAt: new Date(now - 3_600_000).toISOString(), failoverTargets: JSON.stringify([{ targetIp: "203.0.113.6", targetPort: 443 }]) },
    { id: 71, name: "网页", hostId: 1, tunnelId: 7, targetIp: "203.0.113.9", targetPort: 80, isEnabled: true, isRunning: true },
  ],
});
const link = model.links.find((item) => item.id === 7)!;
const noop = () => undefined;
const props = (patch: Partial<LinkPanelProps> = {}): LinkPanelProps => ({
  model, link, tab: "overview", onTab: noop, range: "1h", onRange: noop,
  live: { down: null, up: null, latency: null, latencyDelta: null, loading: false },
  detail: { latency: null, latencyLoading: false, latencyError: null, traffic: { day: null, total: null }, onDiagnose: null, diagnosing: false, onOpenNode: noop },
  onOpenNode: noop, onFocusPath: noop, onViewDetail: noop, viewDetailLabel: "查看详情",
  ...patch,
});

test("五个标签：总览、节点、链路、流量、策略", () => {
  const html = renderToStaticMarkup(<LinkPanelTabs tab="policy" onTab={noop} />);
  assert.deepEqual([...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((match) => match[1]), ["总览", "节点", "链路", "流量", "策略"]);
  assert.match(html, /aria-selected="true"[^>]*>策略/);
});

test("总览：基本信息、一跳一行的网络路径（最后是落地）、实时数据没数据写「—」、查看详情", () => {
  const html = renderToStaticMarkup(<LinkPanelBody {...props()} />);
  assert.match(html, /基本信息/);
  assert.match(html, /健康/);
  assert.match(html, /主线路/);
  assert.match(html, /203\.0\.113\.5:443<\/span><span class="nm-dim-text"> 等 2 个/);
  assert.match(html, new RegExp(formatDateTime(now - 3_600_000)), "最近切换取 Agent 报上来的那次");
  assert.match(html, /2026-01-02 03:04/);
  // 网络路径：入口 / 中继 / 出口，各跳的延迟来自逐跳诊断，最后两行是落地
  assert.deepEqual([...html.matchAll(/class="nm-role is-(\w+)"/g)].map((match) => match[1]), ["entry", "relay", "exit", "landing", "landing"]);
  assert.match(html, /东京/);
  assert.match(html, /31 ms/);
  assert.match(html, /88 ms/);
  assert.match(html, /查看地图/);
  // 实时数据：四张卡，没有数据就是「—」，探测成功率写「没有探测记录」
  for (const label of ["下行速率", "上行速率", "延迟", "探测成功率"]) assert.match(html, new RegExp(label));
  assert.match(html, /没有探测记录/);
  assert.match(html, /最近 1 小时/);
  assert.match(html, /class="nm-primary"[^>]*>查看详情/);
});

test("实时数据有数时写速率和变化", () => {
  const html = renderToStaticMarkup(<LinkPanelBody {...props({ live: { down: { series: [1, 2], avg: 1_500_000, previousAvg: 1_000_000, delta: 50 }, up: { series: [], avg: 0, previousAvg: null, delta: null }, latency: null, latencyDelta: null, loading: false } })} />);
  assert.match(html, /<b class="nm-num">12\.0<\/b><small>Mbps<\/small>/);
  assert.match(html, /\+50\.0% 较上一段/);
});

test("策略：列出挂在这条隧道上的线路组，没有就是一句空状态", () => {
  const html = renderToStaticMarkup(<LinkPanelBody {...props({ tab: "policy" })} />);
  assert.match(html, /游戏/);
  assert.match(html, /自动故障切换/);
  assert.match(html, /正在走/);
  const other = model.links.find((item) => item.id === 8)!;
  assert.match(renderToStaticMarkup(<LinkPanelBody {...props({ tab: "policy", link: other })} />), /没有开线路组/);
});

test("面板的小工具：状态说法、落地、最近切换", () => {
  assert.equal(linkStatusLabel({ health: "healthy" }), "健康");
  assert.equal(linkStatusLabel({ health: "down" }), "故障");
  assert.deepEqual(linkLandings(model, 7), ["203.0.113.5:443", "203.0.113.9:80"]);
  assert.equal(lastSwitchAt(model, 7), Math.floor((now - 3_600_000) / 1000) * 1000);
  assert.equal(lastSwitchAt(model, 8), null);
  assert.equal(formatDateTime(null), "—");
});
