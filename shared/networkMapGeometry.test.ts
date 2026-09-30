import assert from "node:assert/strict";
import test from "node:test";

import { arrowTriangleAlong, boundsForPoints, computeMapLayout, greatCircleArc, type LngLat } from "./networkMapGeometry";

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

test("spreadOnly：缩到全球也不聚簇，挨着的点错开成环、都还在", () => {
  const layout = computeMapLayout([
    { key: "h1", lngLat: [113.26, 23.13] },
    { key: "h2", lngLat: [113.31, 23.12] },
    { key: "h3", lngLat: [-118.24, 34.05] },
  ], project, 1.5, { spreadOnly: true });
  assert.equal(layout.mode, "spread");
  assert.equal(layout.groups.length, 0, "没有簇 pill");
  assert.equal(layout.pos.h1.clusterId, null);
  assert.equal(layout.pos.h2.clusterId, null);
  assert.notDeepEqual(layout.pos.h1.offset, [0, 0], "同城两台错开");
  assert.notDeepEqual(layout.pos.h1.offset, layout.pos.h2.offset);
  assert.deepEqual(layout.pos.h3.offset, [0, 0], "单独的点不动");
});

test("箭头：沿弧线末端方向、从箭尖退开一段，太短的弧不画", () => {
  const arrow = arrowTriangleAlong([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }, { x: 100.4, y: 0 }], 10, 16);
  assert.ok(arrow, "画得出来");
  const [apex, left, right] = arrow!;
  assert.ok(Math.abs(apex.x - 84.4) < 1e-9 && Math.abs(apex.y) < 1e-9, `箭尖退开 16px: ${JSON.stringify(apex)}`);
  assert.ok(Math.abs(left.x - 74.4) < 1e-9 && Math.abs(right.x - 74.4) < 1e-9, "底边在箭尖后 size 处");
  assert.ok(Math.abs(left.y + right.y) < 1e-9 && Math.abs(left.y - right.y) > 10, "两个底角对称张开");
  assert.equal(arrowTriangleAlong([{ x: 0, y: 0 }, { x: 3, y: 0 }], 10, 16), null, "整条弧不到 8px 不画");
});
