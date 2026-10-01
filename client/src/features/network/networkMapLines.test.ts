import assert from "node:assert/strict";
import test from "node:test";

import { LINE_KIND_SHORT, lineKindOfHealth, nodeLatency, nodeTone, pickHubNode } from "./networkMapLines";
import { buildNetworkMapModel, mapCityName, mapRegionText } from "./networkMapModel";

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
  });
}

test("四类线：正常 = 主线路、降级 / 切换中 = 降级、故障 = 中断、停用和未上报 = 备用", () => {
  assert.equal(lineKindOfHealth("healthy"), "main");
  assert.equal(lineKindOfHealth("degraded"), "degraded");
  assert.equal(lineKindOfHealth("switching"), "degraded");
  assert.equal(lineKindOfHealth("down"), "down");
  assert.equal(lineKindOfHealth("standby"), "backup");
  assert.equal(lineKindOfHealth("unknown"), "backup", "没结论的不画成实线");
  assert.deepEqual(Object.values(LINE_KIND_SHORT), ["主线路", "备用", "降级", "中断"]);
});

test("隧道按状态归类，图例数四类线（画不成线的也算）", () => {
  const model = sample();
  const kinds = Object.fromEntries(model.links.map((link) => [link.name, link.kind]));
  assert.deepEqual(kinds, { 主: "main", 经新加坡: "main", 停着的: "backup", 到悉尼: "down", 新洛: "main" });
  assert.deepEqual(model.lines, { main: 3, backup: 1, degraded: 0, down: 1 });
});

test("枢纽：挂线最多（≥2）的在线主机", () => {
  const model = sample();
  assert.equal(pickHubNode(model), 2, "东京挂着四条线");
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
