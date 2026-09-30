import assert from "node:assert/strict";
import test from "node:test";

import { buildNetworkMapModel } from "./networkMapModel";
import { MINI_CAP_MIN_ARC_PX, MINI_FIT_MAX_ZOOM, detectWebGL, locatedHostCount, miniFitPoints, miniOpenHref, shouldRenderRealMap, unlocatedHostCount } from "./networkMapMini";

const now = 1_700_000_000_000;
const host = (id: number, geo?: [number, number]) => ({
  id, name: `h${id}`, isOnline: true, lastHeartbeat: now - 1000,
  ...(geo ? { geoLatitudeMicro: Math.round(geo[0] * 1e6), geoLongitudeMicro: Math.round(geo[1] * 1e6) } : {}),
});

test("小图只框主机；开了落地流向再加上定位到的目标；没坐标的主机数出来", () => {
  const model = buildNetworkMapModel({
    now,
    hosts: [host(1, [22.32, 114.17]), host(2, [35.68, 139.65]), host(3)],
    tunnels: [{ id: 1, name: "t", mode: "forwardx", isEnabled: true, entryHostId: 1, exitHostId: 2 }],
    rules: [{ id: 9, name: "r", hostId: 1, tunnelId: 1, sourcePort: 1, targetIp: "1.1.1.1", targetPort: 80, isEnabled: true, isRunning: true }],
    targetGeo: [{ target: "1.1.1.1", geo: { latitude: -33.9, longitude: 151.2 } }],
  });
  assert.equal(locatedHostCount(model), 2);
  assert.equal(unlocatedHostCount(model), 1);
  assert.deepEqual(miniFitPoints(model, false), [[114.17, 22.32], [139.65, 35.68]]);
  assert.deepEqual(miniFitPoints(model, true), [[114.17, 22.32], [139.65, 35.68], [151.2, -33.9]]);
});

test("画真地图的条件：有 WebGL 且至少一台主机定位到了；node 里没有 WebGL", () => {
  assert.equal(shouldRenderRealMap({ webgl: true, locatedHosts: 1 }), true);
  assert.equal(shouldRenderRealMap({ webgl: true, locatedHosts: 0 }), false, "一台都没定位：示意图");
  assert.equal(shouldRenderRealMap({ webgl: false, locatedHosts: 3 }), false, "没有 WebGL：示意图");
  assert.equal(detectWebGL(), false);
});

test("小图的常量：最多放到 9 级，90px 以上才挂胶囊；点主机 / 线跳整页并带上它", () => {
  assert.equal(MINI_FIT_MAX_ZOOM, 9);
  assert.equal(MINI_CAP_MIN_ARC_PX, 90);
  assert.equal(miniOpenHref({ kind: "host", id: 3 }), "/map?host=3");
  assert.equal(miniOpenHref({ kind: "link", id: 12 }), "/map?link=12");
  assert.equal(miniOpenHref(null), "/map");
});
