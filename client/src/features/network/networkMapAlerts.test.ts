import assert from "node:assert/strict";
import test from "node:test";

import { NETWORK_MAP_LATENCY_WARN_MS, buildNetworkMapAlerts } from "./networkMapAlerts";
import { buildNetworkMapModel, tunnelHopLatencies } from "./networkMapModel";

const now = 1_700_000_000_000;
const online = (id: number, name: string, extra: Record<string, unknown> = {}) => ({ id, name, isOnline: true, lastHeartbeat: now - 1000, geoRegion: "香港", geoCountryCode: "HK", ...extra });
const tunnel = (id: number, name: string, entry: number, exit: number, extra: Record<string, unknown> = {}) => ({
  id, name, mode: "forwardx", isEnabled: true, entryHostId: entry, exitHostId: exit, hopHostIds: [entry, exit], ...extra,
});

test("告警：主机离线是 Error，排在最前，聚焦它和经过它的隧道", () => {
  const model = buildNetworkMapModel({
    now,
    hosts: [online(1, "gz"), { id: 2, name: "hk", isOnline: false, lastHeartbeat: now - 5 * 60_000, geoRegion: "香港" }, online(3, "la")],
    tunnels: [tunnel(10, "gz-hk", 1, 2), tunnel(11, "slow", 1, 3, { lastLatencyMs: 300 })],
  });
  const alerts = buildNetworkMapAlerts(model, now);
  assert.equal(alerts[0].id, "host-offline:2");
  assert.equal(alerts[0].severity, "error");
  assert.equal(alerts[0].title, "hk 离线");
  assert.match(alerts[0].detail, /最后在线 5 分钟前/);
  assert.deepEqual(alerts[0].focus.hosts, [2]);
  assert.deepEqual(alerts[0].focus.tunnels, [10]);
  assert.deepEqual(alerts[0].open, { view: "node", id: 2 });
  // 隧道因为必经主机离线而中断：Error，排在主机后面
  assert.equal(alerts[1].id, "tunnel-down:10");
  assert.equal(alerts[1].severity, "error");
  assert.match(alerts[1].detail, /gz → hk/);
  // 延迟高：Warning，排最后
  assert.equal(alerts[2].id, "tunnel-latency:11");
  assert.equal(alerts[2].severity, "warning");
  assert.equal(alerts[2].title, "slow 延迟 300 ms");
  assert.match(alerts[2].detail, new RegExp(`高于 ${NETWORK_MAP_LATENCY_WARN_MS} ms`));
});

test("告警：FXP 过旧优先于「中断」，文字来自 fxpIssues；停用的隧道不报", () => {
  const model = buildNetworkMapModel({
    now,
    hosts: [online(1, "a"), online(2, "b")],
    tunnels: [
      tunnel(10, "nex", 1, 2, { fxpIssues: [{ hostId: 2, message: "b 的 FXP 版本过旧（2.2.120），需要升级 Agent" }], lastLatencyMs: 999 }),
      tunnel(11, "paused", 1, 2, { isEnabled: false, lastLatencyMs: 999 }),
    ],
    isTunnelSupported: (t: any) => Number(t.id) !== 10,
  });
  const alerts = buildNetworkMapAlerts(model, now);
  assert.deepEqual(alerts.map((a) => a.id), ["tunnel-fxp:10"], "FXP 那条只报一次，停用的隧道延迟再高也不算");
  assert.equal(alerts[0].action, "升级 Agent");
  assert.equal(alerts[0].detail, "b 的 FXP 版本过旧（2.2.120），需要升级 Agent");
});

test("告警：被系统停用的规则是 Warning，聚焦入口主机和目标", () => {
  const model = buildNetworkMapModel({
    now,
    hosts: [online(1, "a"), online(2, "b")],
    tunnels: [tunnel(10, "t", 1, 2)],
    rules: [
      { id: 5, name: "r1", hostId: 1, tunnelId: 10, sourcePort: 4000, targetIp: "Example.COM", targetPort: 443, isEnabled: false, protocolBlockReason: "端口冲突" },
      { id: 6, name: "r2", hostId: 1, tunnelId: 10, sourcePort: 4001, targetIp: "1.2.3.4", targetPort: 443, isEnabled: false },
    ],
  });
  const alerts = buildNetworkMapAlerts(model, now);
  assert.deepEqual(alerts.map((a) => a.id), ["rule-blocked:5"], "手动关掉的规则不算告警");
  assert.equal(alerts[0].severity, "warning");
  assert.match(alerts[0].detail, /端口冲突 · 在 a 上 · :4000/);
  assert.deepEqual(alerts[0].focus, { hosts: [1], tunnels: [10], targets: ["example.com"], rules: [5] });
  assert.equal(model.rules[0].exitHostId, 2, "走隧道的规则出口是隧道路径最后一台");
  assert.equal(model.targets.length, 2);
  assert.equal(model.targets[0].geo, null, "没定位的目标不给坐标");
});

test("模型：落地目标按定位结果落点、汇总指向它的规则；逐跳延迟从诊断结果对上 path", () => {
  const model = buildNetworkMapModel({
    now,
    hosts: [online(1, "a"), online(2, "b")],
    tunnels: [tunnel(10, "t", 1, 2, {
      lastTestMessage: JSON.stringify({ message: "ok", details: [{ success: true, latencyMs: 7, fromHostId: 1, toHostId: 2 }] }),
    })],
    rules: [
      { id: 5, name: "r1", hostId: 1, tunnelId: 10, sourcePort: 4000, targetIp: "1.2.3.4", targetPort: 443, isEnabled: true, isRunning: true },
      { id: 6, name: "r2", hostId: 1, tunnelId: null, sourcePort: 4001, targetIp: "1.2.3.4", targetPort: 80, isEnabled: true, isRunning: true },
    ],
    targetGeo: [{ target: "1.2.3.4", geo: { latitude: 34.05, longitude: -118.24, countryCode: "us", region: "洛杉矶" } }],
  });
  assert.equal(model.targets.length, 1);
  const target = model.targets[0];
  assert.deepEqual(target.geo, { lat: 34.05, lng: -118.24 });
  assert.equal(target.countryCode, "US");
  assert.equal(target.city, "洛杉矶");
  assert.deepEqual(target.ruleIds, [5, 6]);
  assert.deepEqual(target.sourceHostIds, [2, 1], "走隧道的从出口拉线，直连的从入口拉线");
  assert.deepEqual(model.links[0].hopLatencies, [7]);
  assert.equal(model.links[0].modeLabel, "NEX V1");
  assert.deepEqual(tunnelHopLatencies({ lastTestMessage: "plain text" }, [1, 2]), []);
  assert.deepEqual(buildNetworkMapAlerts(model, now), []);
});

test("模型：租户看不到一端的隧道从看得见的那端画一截灰线", () => {
  const model = buildNetworkMapModel({
    now,
    hosts: [online(1, "mine")],
    tunnels: [{ id: 10, name: "shared", mode: "tls", isEnabled: true, entryHostId: 1, exitHostId: null, hopHostIds: [1], availability: { status: "available", available: true, source: "hosts", message: "online" } }],
  });
  assert.equal(model.links.length, 0);
  assert.equal(model.hiddenLinkCount, 1);
  assert.deepEqual(model.stubs, [{ tunnelId: 10, name: "shared", hostId: 1, health: "healthy", modeLabel: "GOST TLS" }]);
});
