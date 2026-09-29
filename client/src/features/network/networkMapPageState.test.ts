import assert from "node:assert/strict";
import test from "node:test";

import { buildNetworkMapModel } from "./networkMapModel";
import {
  clampSheetY,
  focusForLink,
  focusForNode,
  focusForTarget,
  isClusterDimmed,
  isFlowDimmed,
  isHostDimmed,
  mapPaddingForSheet,
  nextSheetSnap,
  overviewHeadline,
  sheetSnapY,
} from "./networkMapPageState";

test("三档的位置：收起露 84px，半屏露 48%，全屏露 90%", () => {
  assert.equal(sheetSnapY("peek", 800), 716);
  assert.equal(sheetSnapY("half", 800), 416);
  assert.equal(sheetSnapY("full", 800), 80);
  assert.equal(clampSheetY(-50, 800), 80, "拖过头夹回全屏");
  assert.equal(clampSheetY(900, 800), 716, "拖到底夹回收起");
});

test("松手：几乎没动时收起的升到半屏、其他档不变", () => {
  assert.equal(nextSheetSnap({ current: "peek", startY: 700, endY: 703, velocity: 0, containerHeight: 800 }), "half");
  assert.equal(nextSheetSnap({ current: "half", startY: 400, endY: 402, velocity: 0, containerHeight: 800 }), "half");
});

test("松手：快速甩动按方向走一档，到头不越界", () => {
  assert.equal(nextSheetSnap({ current: "half", startY: 400, endY: 420, velocity: 1.2, containerHeight: 800 }), "peek");
  assert.equal(nextSheetSnap({ current: "half", startY: 400, endY: 380, velocity: -1.2, containerHeight: 800 }), "full");
  assert.equal(nextSheetSnap({ current: "full", startY: 100, endY: 80, velocity: -1.2, containerHeight: 800 }), "full");
  assert.equal(nextSheetSnap({ current: "peek", startY: 700, endY: 720, velocity: 1.2, containerHeight: 800 }), "peek");
});

test("松手：慢慢拖吸附到最近的一档", () => {
  // 从收起（716）往上拖 250 → 466，离半屏（416）最近
  assert.equal(nextSheetSnap({ current: "peek", startY: 700, endY: 450, velocity: -0.1, containerHeight: 800 }), "half");
  // 从半屏（416）往上拖 300 → 116，离全屏（80）最近
  assert.equal(nextSheetSnap({ current: "half", startY: 400, endY: 100, velocity: -0.2, containerHeight: 800 }), "full");
});

test("地图留白跟着抽屉走，桌面右侧栏不压底部", () => {
  assert.deepEqual(mapPaddingForSheet("peek", 800, false), { top: 64, bottom: 96, left: 20, right: 20 });
  assert.equal(mapPaddingForSheet("half", 800, false).bottom, 396);
  assert.equal(mapPaddingForSheet("full", 800, false).bottom, 452);
  assert.equal(mapPaddingForSheet("full", 800, true).bottom, 30);
});

const model = buildNetworkMapModel({
  now: 1_000_000,
  hosts: [
    { id: 1, name: "GZ", isOnline: true, geoLatitudeMicro: 23_000_000, geoLongitudeMicro: 113_000_000 },
    { id: 2, name: "HK", isOnline: true, geoLatitudeMicro: 22_300_000, geoLongitudeMicro: 114_200_000 },
    { id: 3, name: "US", isOnline: true, geoLatitudeMicro: 34_000_000, geoLongitudeMicro: -118_000_000 },
  ],
  tunnels: [
    { id: 10, name: "gz-hk", entryHostId: 1, exitHostId: 2, isEnabled: true, availability: { status: "available", message: "" } },
    { id: 11, name: "hk-us", entryHostId: 2, exitHostId: 3, isEnabled: true, availability: { status: "available", message: "" } },
  ],
  rules: [
    { id: 100, name: "r1", hostId: 1, tunnelId: 10, sourcePort: 40000, targetIp: "1.2.3.4", targetPort: 443, isEnabled: true, isRunning: true },
    { id: 101, name: "r2", hostId: 2, tunnelId: 11, sourcePort: 40001, targetIp: "5.6.7.8", targetPort: 443, isEnabled: true, isRunning: true },
  ],
  targetGeo: [{ target: "1.2.3.4", geo: { latitude: 1.3, longitude: 103.8, countryCode: "SG" } }],
});

test("聚焦一台主机：它、经过它的线、两端主机和它作为出口指向的目标都亮着", () => {
  const focus = focusForNode(model, 2);
  assert.ok(focus);
  assert.deepEqual(focus!.tunnels.sort(), [10, 11]);
  assert.deepEqual(focus!.hosts.sort(), [1, 2, 3]);
  assert.deepEqual(focus!.targets, ["1.2.3.4"]);
  assert.equal(isHostDimmed(focus, 3), false);
  assert.equal(focusForNode(model, 99), null);
});

test("聚焦一条线：只亮这条线、它的两端和走它的规则的目标", () => {
  const focus = focusForLink(model, 10);
  assert.ok(focus);
  assert.deepEqual(focus!.hosts, [1, 2]);
  assert.deepEqual(focus!.targets, ["1.2.3.4"]);
  assert.deepEqual(focus!.rules, [100]);
  assert.equal(isHostDimmed(focus, 3), true);
  assert.equal(isFlowDimmed(focus, "5.6.7.8", [101]), true);
  assert.equal(isFlowDimmed(focus, "1.2.3.4", [100]), false);
});

test("聚焦一个目标：亮它的出口、入口和走的隧道", () => {
  const focus = focusForTarget(model, "1.2.3.4");
  assert.ok(focus);
  assert.deepEqual(focus!.tunnels, [10]);
  assert.ok(focus!.hosts.includes(1) && focus!.hosts.includes(2));
  assert.equal(isClusterDimmed(focus, [{ kind: "host", id: 3 }]), true);
  assert.equal(isClusterDimmed(focus, [{ kind: "host", id: 3 }, { kind: "target", key: "1.2.3.4" }]), false);
  assert.equal(isClusterDimmed(null, [{ kind: "host", id: 3 }]), false);
});

test("页头那句话：有告警才带「N 项需要关注」", () => {
  assert.deepEqual(overviewHeadline(model, 0), { main: "3 台主机 · 2 条线路", attention: null });
  assert.equal(overviewHeadline(model, 2).attention, "2 项需要关注");
});
