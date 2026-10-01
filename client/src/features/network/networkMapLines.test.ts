import assert from "node:assert/strict";
import test from "node:test";

import {
  LINE_KIND_LABELS,
  backupsForTunnel,
  formatAvailability,
  hostsForFilter,
  lineKindOfHealth,
  lineTotal,
  nodeLatency,
  nodeTone,
  overallAvailability,
  pickHubNode,
} from "./networkMapLines";
import { buildNetworkMapModel, mapCityName, mapRegionText, readTargetGeo } from "./networkMapModel";

const now = 1_700_000_000_000;
const host = (id: number, name: string, extra: Record<string, unknown> = {}) => ({ id, name, isOnline: true, lastHeartbeat: now - 1000, geoCountryCode: "HK", geoRegion: name, geoLatitudeMicro: 22e6 + id * 1e6, geoLongitudeMicro: 114e6 + id * 1e6, ...extra });
const ok = { latestLatencyMs: 20, latestLatencyAt: new Date(now - 60_000).toISOString() };
const tunnel = (id: number, name: string, path: number[], extra: Record<string, unknown> = {}) => ({
  id, name, mode: "tls", isEnabled: true, entryHostId: path[0], exitHostId: path[path.length - 1], hopHostIds: path, ...ok, ...extra,
});

function sample() {
  return buildNetworkMapModel({
    now,
    hosts: [host(1, "香港"), host(2, "东京"), host(3, "新加坡"), host(4, "洛杉矶"), host(5, "悉尼", { isOnline: false, lastHeartbeat: now - 3_600_000 })],
    tunnels: [
      tunnel(10, "主", [1, 2], { lastLatencyMs: 40 }),
      tunnel(11, "经新加坡", [1, 3, 2], { lastLatencyMs: 90, lastTestMessage: JSON.stringify({ details: [{ fromHostId: 1, toHostId: 3, latencyMs: 30 }, { fromHostId: 3, toHostId: 2, latencyMs: 55 }] }) }),
      tunnel(12, "停着的", [1, 2], { isEnabled: false }),
      tunnel(13, "到悉尼", [2, 5], { latestLatencyIsTimeout: true }),
      tunnel(14, "新洛", [3, 4]),
    ],
    rules: [
      {
        id: 100, name: "线路组", hostId: 1, targetIp: "10.0.0.1", targetPort: 443, isEnabled: true, isRunning: true, failoverEnabled: true, routeMode: "failover",
        routePaths: JSON.stringify([
          { key: "a", name: "主线路", hops: [2], dest: null, weight: 50, probe: null, dial: null },
          { key: "b", name: "经新加坡", hops: [3, 4], dest: { ip: "10.0.0.2", port: 443 }, weight: 50, probe: null, dial: null },
          { key: "c", name: "直连", hops: [], dest: { ip: "10.0.0.3", port: 443 }, weight: 50, probe: null, dial: null },
        ]),
      },
      {
        id: 101, name: "隧道上的主备", hostId: 1, tunnelId: 10, targetIp: "10.0.1.1", targetPort: 80, isEnabled: true, isRunning: true, failoverEnabled: true,
        routePaths: JSON.stringify([
          { key: "m", name: "", hops: [], dest: null, weight: 50, probe: null, dial: null },
          { key: "n", name: "", hops: [4], dest: { ip: "10.0.1.2", port: 80 }, weight: 50, probe: null, dial: null },
        ]),
      },
    ],
  });
}

test("四类线：正常 = 主线路、降级 / 切换中 = 降级、故障 = 中断、停用和未上报 = 备用", () => {
  assert.equal(lineKindOfHealth("healthy"), "main");
  assert.equal(lineKindOfHealth("degraded"), "degraded");
  assert.equal(lineKindOfHealth("switching"), "degraded");
  assert.equal(lineKindOfHealth("down"), "down");
  assert.equal(lineKindOfHealth("standby"), "backup");
  assert.equal(lineKindOfHealth("unknown"), "backup", "没结论的不画成实线");
  assert.deepEqual(Object.values(LINE_KIND_LABELS), ["主线路", "备用线路", "降级线路", "中断线路"]);
});

test("隧道按状态归类；线路组只画经过中转的路径，正在走的是主线路、其余是备用", () => {
  const model = sample();
  const kinds = Object.fromEntries(model.links.map((link) => [link.name, link.kind]));
  assert.deepEqual(kinds, { 主: "main", 经新加坡: "main", 停着的: "backup", 到悉尼: "down", 新洛: "main" });
  assert.deepEqual(model.routes.map((route) => [route.key, route.hosts, route.active, route.kind]), [
    ["r:100:a", [1, 2], true, "main"],
    ["r:100:b", [1, 3, 4], false, "backup"],
    // 挂在隧道上的规则：调度在隧道出口（东京）
    ["r:101:n", [2, 4], false, "backup"],
  ]);
  assert.deepEqual(model.lines, { main: 4, backup: 3, degraded: 0, down: 1 });
  assert.equal(lineTotal(model), 8);
  const group = model.rules.find((rule) => rule.id === 100)!.routeGroup!;
  assert.equal(group.modeLabel, "自动故障切换");
  assert.equal(group.activeIndex, null, "Agent 没报过就是 null，不冒充主线路");
  assert.deepEqual(group.paths.map((path) => path.dest), ["10.0.0.1:443", "10.0.0.2:443", "10.0.0.3:443"]);
});

test("整体可用率：能用的 / 该能用的，停用和未上报不算；一条都没有是 null", () => {
  const model = sample();
  // 该能用：主、经新加坡、到悉尼、新洛 四条（停着的不算）；能用三条
  assert.equal(overallAvailability(model), 75);
  assert.equal(formatAvailability(overallAvailability(model)), "75.0%");
  assert.equal(overallAvailability({ links: [], stubs: [{ tunnelId: 1, name: "x", hostId: 1, health: "unknown", modeLabel: "" }] }), null, "未上报的不算");
  assert.equal(overallAvailability({ links: [], stubs: [] }), null);
  assert.equal(formatAvailability(null), "—");
  assert.equal(formatAvailability(99.97), "100%");
});

test("枢纽：选中的优先；不然是挂线最多（≥2）的在线主机", () => {
  const model = sample();
  assert.equal(pickHubNode(model), 2, "东京挂着四条线");
  assert.equal(pickHubNode(model, 3), 3);
  assert.equal(pickHubNode({ nodes: model.nodes.map((node) => ({ ...node, linkCount: 1 })) }), null);
});

test("主机的颜色：掉线红；在线的看经过它的线；枢纽蓝", () => {
  const model = sample();
  const hub = pickHubNode(model);
  assert.equal(nodeTone(model, 2, hub), "hub");
  assert.equal(nodeTone(model, 1, hub), "ok");
  assert.equal(nodeTone(model, 5, hub), "down");
  assert.equal(nodeTone(model, 999, hub), "standby");
});

test("主机的延迟：逐跳齐全时从入口累加，出口用整条的延迟；入口机没有", () => {
  const model = sample();
  assert.equal(nodeLatency(model, 3), 30);
  assert.equal(nodeLatency(model, 2), 40, "主那条 40 比经新加坡累加的 85 小");
  assert.equal(nodeLatency(model, 1), null);
});

test("主备对比：同入口同出口的备用隧道 + 挂在这条隧道上的线路组里没轮到的路径", () => {
  const model = sample();
  assert.deepEqual(backupsForTunnel(model, 10), { tunnels: [12], routes: ["r:101:n"] });
  assert.deepEqual(backupsForTunnel(model, 13), { tunnels: [], routes: [] });
  assert.deepEqual(backupsForTunnel(model, 999), { tunnels: [], routes: [] });
});

test("筛选：只看中断时剩下那条线两端的主机；全部时不筛", () => {
  const model = sample();
  assert.equal(hostsForFilter(model, "all"), null);
  assert.deepEqual([...hostsForFilter(model, "down")!].sort(), [2, 5]);
});

test("落地目标的定位：认服务端 lookupAddressGeo 那一行（微度），也认 latitude / longitude", () => {
  assert.deepEqual(readTargetGeo({ geoCountryCode: "us", geoRegion: "Los Angeles", geoLatitudeMicro: 34_052_000, geoLongitudeMicro: -118_243_000 }), { geo: { lat: 34.052, lng: -118.243 }, countryCode: "US", city: "Los Angeles" });
  assert.deepEqual(readTargetGeo({ latitude: 1.3, longitude: 103.8, countryCode: "SG" }), { geo: { lat: 1.3, lng: 103.8 }, countryCode: "SG", city: "" });
  assert.equal(readTargetGeo(null).geo, null);
  assert.equal(readTargetGeo({ geoLatitudeMicro: null, geoLongitudeMicro: null }).geo, null);
});

test("图上的地名：一律中文（城市表 → 省 / 州对照 → 国家 / 地区名），全查不到才写原文", () => {
  assert.equal(mapCityName({ geoCountryCode: "JP", geoRegion: "Tokyo" }), "东京");
  assert.equal(mapCityName({ geoCountryCode: "HK", geoRegion: "Central" }), "香港");
  assert.equal(mapCityName({ geoCountryCode: "SG", geoRegion: "Singapore" }), "新加坡");
  assert.equal(mapCityName({ geoCountryCode: "CN", geoRegion: "Guangdong" }), "广东");
  assert.equal(mapCityName({ geoCountryCode: "XX", geoRegion: "Nowhere" }), "Nowhere");
  assert.equal(mapRegionText({ geoCountryCode: "AU", geoRegion: "New South Wales", geoLatitudeMicro: -33_871_500, geoLongitudeMicro: 151_200_600 }), "悉尼");
  assert.equal(mapRegionText({ geoCountryCode: "HK", geoRegion: "Hong Kong" }), "香港");
});

test("用户的拓扑：港粤台悉尼的英文 region 在模型里都成了中文", () => {
  const model = buildNetworkMapModel({
    hosts: [
      { id: 1, name: "Jinx(29.9y)", isOnline: true, lastHeartbeat: now, geoCountryCode: "HK", geoRegion: "Hong Kong", geoLatitudeMicro: 22_278_300, geoLongitudeMicro: 114_174_700 },
      { id: 2, name: "Po0(200M)", isOnline: true, lastHeartbeat: now, geoCountryCode: "CN", geoRegion: "Guangdong", geoLatitudeMicro: 23_116_700, geoLongitudeMicro: 113_250_000 },
      { id: 3, name: "DW TW", isOnline: true, lastHeartbeat: now, geoCountryCode: "TW", geoRegion: "Taipei City", geoLatitudeMicro: 25_047_800, geoLongitudeMicro: 121_531_900 },
      { id: 4, name: "55", isOnline: true, lastHeartbeat: now, geoCountryCode: "AU", geoRegion: "New South Wales", geoLatitudeMicro: -33_871_500, geoLongitudeMicro: 151_200_600 },
    ],
    tunnels: [],
    now,
  });
  assert.deepEqual(model.nodes.map((node) => node.city), ["香港", "广州", "台北", "悉尼"]);
  assert.deepEqual(model.nodes.map((node) => node.region), ["香港", "广州", "台北", "悉尼"]);
});
