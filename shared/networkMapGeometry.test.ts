import assert from "node:assert/strict";
import test from "node:test";

import { boundsForPoints, computeMapLayout, greatCircleArc, type LngLat } from "./networkMapGeometry";

test("大圆弧：两端落在起止点上，中点往高纬度弯，跨日界线不绕地球", () => {
  const pts = greatCircleArc([113.264, 23.129], [-118.243, 34.052], 40);
  assert.equal(pts.length, 41);
  assert.ok(Math.abs(pts[0][0] - 113.264) < 1e-6 && Math.abs(pts[0][1] - 23.129) < 1e-6);
  const last = pts[pts.length - 1];
  assert.ok(Math.abs(((last[0] + 180) % 360 + 360) % 360 - 180 - -118.243) < 1e-6, `终点经度 ${last[0]}`);
  assert.ok(Math.abs(last[1] - 34.052) < 1e-6);
  const mid = pts[20];
  assert.ok(mid[1] > 45, `中点纬度 ${mid[1]} 应该弯到北太平洋`);
  for (let i = 1; i < pts.length; i += 1) {
    assert.ok(Math.abs(pts[i][0] - pts[i - 1][0]) < 90, `相邻两点经度不跳变 (${pts[i - 1][0]} → ${pts[i][0]})`);
  }
});

test("大圆弧：重合的两点退化成两点，不产生 NaN", () => {
  const pts = greatCircleArc([114.17, 22.32], [114.17, 22.32]);
  assert.equal(pts.length, 2);
  assert.ok(pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));
});

// 等距投影：1° = 10px，够测分组逻辑
const project = (p: LngLat) => ({ x: p[0] * 10, y: -p[1] * 10 });

test("缩小时 44px 内的点聚成一个簇，远的点独立", () => {
  const layout = computeMapLayout([
    { key: "h1", lngLat: [113.26, 23.13] },
    { key: "h2", lngLat: [113.31, 23.12] },
    { key: "h3", lngLat: [114.17, 22.32] },
    { key: "h4", lngLat: [-118.24, 34.05] },
  ], project, 3);
  assert.equal(layout.mode, "cluster");
  assert.equal(layout.groups.length, 1);
  assert.deepEqual(layout.groups[0].keys, ["h1", "h2", "h3"]);
  assert.equal(layout.pos.h1.clusterId, layout.groups[0].id);
  assert.equal(layout.pos.h4.clusterId, null);
  assert.deepEqual(layout.pos.h4.lngLat, [-118.24, 34.05]);
});

test("放大后 30px 内的点错开成一圈：同一个中心、不同的像素偏移", () => {
  const layout = computeMapLayout([
    { key: "h1", lngLat: [113.26, 23.13] },
    { key: "h2", lngLat: [113.31, 23.12] },
    { key: "h3", lngLat: [121.47, 31.23] },
  ], project, 7);
  assert.equal(layout.mode, "spread");
  assert.equal(layout.groups.length, 0, "错开模式不出簇");
  assert.deepEqual(layout.pos.h1.lngLat, layout.pos.h2.lngLat);
  assert.notDeepEqual(layout.pos.h1.offset, layout.pos.h2.offset);
  assert.ok(Math.hypot(...layout.pos.h1.offset) > 20);
  assert.deepEqual(layout.pos.h3.offset, [0, 0]);
});

test("外接范围：单点撑开、跨日界线的点挪到 +360 那侧", () => {
  assert.deepEqual(boundsForPoints([]), null);
  const single = boundsForPoints([[114, 22]]);
  assert.deepEqual(single, [[113.7, 21.7], [114.3, 22.3]]);
  const pacific = boundsForPoints([[113, 23], [-118, 34]]);
  assert.ok(pacific && pacific[1][0] === 242 && pacific[0][0] === 113, JSON.stringify(pacific));
});
