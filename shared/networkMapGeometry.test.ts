import assert from "node:assert/strict";
import test from "node:test";

import { arrowTriangleAlong, boundsForPoints, boxOverlapArea, computeMapLayout, fitViewToBoxes, greatCircleArc, unionBox, type FitItem, type LngLat, type PixelBox } from "./networkMapGeometry";

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

test("clusterRadius 内的点并成一组，远的点独立", () => {
  const layout = computeMapLayout([
    { key: "h1", lngLat: [113.26, 23.13] },
    { key: "h2", lngLat: [113.31, 23.12] },
    { key: "h3", lngLat: [114.17, 22.32] },
    { key: "h4", lngLat: [-118.24, 34.05] },
  ], project, { clusterRadius: 44 });
  assert.equal(layout.groups.length, 1);
  assert.deepEqual(layout.groups[0].keys, ["h1", "h2", "h3"]);
  assert.equal(layout.pos.h1.clusterId, layout.groups[0].id);
  assert.equal(layout.pos.h4.clusterId, null);
  assert.deepEqual(layout.pos.h4.lngLat, [-118.24, 34.05]);
});

test("外接范围：单点撑开、跨日界线的点挪到 +360 那侧", () => {
  assert.deepEqual(boundsForPoints([]), null);
  const single = boundsForPoints([[114, 22]]);
  assert.deepEqual(single, [[113.7, 21.7], [114.3, 22.3]]);
  const pacific = boundsForPoints([[113, 23], [-118, 34]]);
  assert.ok(pacific && pacific[1][0] === 242 && pacific[0][0] === 113, JSON.stringify(pacific));
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

// ---- 小图的精确框住 ----

/** 真正的 Web 墨卡托投影（512 像素的世界，zoom 级），中心放在容器正中 */
function mercatorProjector(center: LngLat, zoom: number, container: { width: number; height: number }) {
  const world = 512 * 2 ** zoom;
  const toWorld = (p: LngLat) => {
    const x = ((p[0] + 180) / 360) * world;
    const sin = Math.sin((p[1] * Math.PI) / 180);
    const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * world;
    return { x, y };
  };
  const c = toWorld(center);
  return (p: LngLat) => { const w = toWorld(p); return { x: w.x - c.x + container.width / 2, y: w.y - c.y + container.height / 2 }; };
}

/** 用户的拓扑：港粤台五台 + 悉尼一台 */
const USER_HOSTS: LngLat[] = [[114.2, 22.3], [113.3, 23.1], [121.5, 25.0], [114.0, 22.5], [113.6, 22.9], [151.2, -33.9]];

/** 每台主机：26px 圆盘（含 4px 光晕）+ 下面 90×14 的名字 */
function hostItems(project: (p: LngLat) => { x: number; y: number }, hosts: readonly LngLat[]): FitItem[] {
  return hosts.map((host) => {
    const anchor = project(host);
    const disc: PixelBox = { x: anchor.x - 17, y: anchor.y - 17, w: 34, h: 34 };
    const name: PixelBox = { x: anchor.x - 45, y: anchor.y + 15, w: 90, h: 14 };
    return { anchor, box: unionBox([disc, name])! };
  });
}

/** 把 fitViewToBoxes 的结果套到盒子上：p' = c0 + k(p − c0) + pan，pan 由 centerPx 反推 */
function applyFit(items: readonly FitItem[], container: { width: number; height: number }, fit: { scale: number; centerPx: { x: number; y: number } }): PixelBox[] {
  const c0 = { x: container.width / 2, y: container.height / 2 };
  const pan = { x: (c0.x - fit.centerPx.x) * fit.scale, y: (c0.y - fit.centerPx.y) * fit.scale };
  return items.map((item) => {
    const nx = c0.x + fit.scale * (item.anchor.x - c0.x) + pan.x;
    const ny = c0.y + fit.scale * (item.anchor.y - c0.y) + pan.y;
    return { x: nx - (item.anchor.x - item.box.x), y: ny - (item.anchor.y - item.box.y), w: item.box.w, h: item.box.h };
  });
}

const inside = (box: PixelBox, container: { width: number; height: number }, inset: number) =>
  box.x >= inset - 1e-6 && box.y >= inset - 1e-6 && box.x + box.w <= container.width - inset + 1e-6 && box.y + box.h <= container.height - inset + 1e-6;

for (const container of [{ width: 390, height: 300 }, { width: 1054, height: 380 }]) {
  test(`精确框住 ${container.width}×${container.height}：港粤台 + 悉尼，每个盘和名字都在 10px 留白之内`, () => {
    // 先按 fitBounds 那样粗放一个位置：中心在两头中间、缩放故意偏大（最北的那台会被裁掉半个盘）
    const zoom = 2.6;
    const project = mercatorProjector([132, -6], zoom, container);
    const items = hostItems(project, USER_HOSTS);
    assert.ok(items.some((item) => !inside(item.box, container, 10)), "一开始有主机贴边 / 出界");
    const fit = fitViewToBoxes(container, items, { top: 10, right: 10, bottom: 10, left: 10 }, { maxScale: 2 ** (9 - zoom), minScale: 2 ** (0 - zoom) });
    assert.ok(fit && fit.fits, "放得下");
    const boxes = applyFit(items, container, fit!);
    for (const box of boxes) assert.ok(inside(box, container, 10), `盒子出界 ${JSON.stringify(box)}`);
    // 并集居中：上下 / 左右留白相等
    const union = unionBox(boxes)!;
    assert.ok(Math.abs(union.y - (container.height - union.y - union.h)) < 0.5, "上下留白一样");
    assert.ok(Math.abs(union.x - (container.width - union.x - union.w)) < 0.5, "左右留白一样");
    // 不多缩：至少有一个方向贴着留白线（最小的能放下的缩放）
    const slackY = union.y - 10;
    const slackX = union.x - 10;
    assert.ok(Math.min(slackX, slackY) < 0.5, `没有多缩 (${slackX}, ${slackY})`);
  });
}

test("精确框住：空间富余时往里放大，但不超过 maxScale（两台同城不缩成街道图）", () => {
  const container = { width: 390, height: 300 };
  const zoom = 5;
  const project = mercatorProjector([114.2, 22.32], zoom, container);
  const items = hostItems(project, [[114.17, 22.32], [114.22, 22.28]]);
  const fit = fitViewToBoxes(container, items, { top: 10, right: 10, bottom: 10, left: 10 }, { maxScale: 2 ** (9 - zoom) })!;
  assert.ok(fit.scale > 1, "往里放大");
  assert.ok(Math.abs(fit.zoomDelta - 4) < 1e-9, `到 9 级为止 (${fit.zoomDelta})`);
  for (const box of applyFit(items, container, fit)) assert.ok(inside(box, container, 10));
  // 没有点：null；默认只缩不放
  assert.equal(fitViewToBoxes(container, [], { top: 10, right: 10, bottom: 10, left: 10 }), null);
  assert.equal(fitViewToBoxes(container, items, { top: 10, right: 10, bottom: 10, left: 10 })!.scale, 1);
});

test("精确框住：缩到 minScale 还放不下时 fits 为 false，但仍然居中", () => {
  const container = { width: 200, height: 100 };
  const items: FitItem[] = [
    { anchor: { x: 20, y: 50 }, box: { x: -40, y: 30, w: 120, h: 40 } },
    { anchor: { x: 180, y: 50 }, box: { x: 120, y: 30, w: 120, h: 40 } },
  ];
  const fit = fitViewToBoxes(container, items, { top: 10, right: 10, bottom: 10, left: 10 }, { minScale: 0.5 })!;
  assert.equal(fit.fits, false);
  assert.equal(fit.scale, 0.5);
});

test("盒子工具：重叠面积、并集", () => {
  assert.equal(boxOverlapArea({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), 25);
  assert.equal(boxOverlapArea({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }), 0, "贴边不算重叠");
  assert.deepEqual(unionBox([{ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }]), { x: 0, y: 0, w: 15, h: 15 });
});

test("首页地图：28px 半径，港粤四台并成一组、台湾和悉尼单独；线从组心出发", () => {
  const container = { width: 390, height: 300 };
  const project = mercatorProjector([132, -6], 1.6, container);
  const layout = computeMapLayout(USER_HOSTS.map((lngLat, index) => ({ key: `h${index + 1}`, lngLat })), project, { clusterRadius: 28 });
  assert.equal(layout.groups.length, 1);
  assert.deepEqual(layout.groups[0].keys, ["h1", "h2", "h4", "h5"]);
  assert.equal(layout.pos.h3.clusterId, null, "台湾在 1.6 级上离港粤 30 多像素，单独画");
  assert.equal(layout.pos.h6.clusterId, null);
  assert.deepEqual(layout.pos.h6.lngLat, [151.2, -33.9], "悉尼画在真实坐标");
  // 港 → 美：组里的那一端从组心出发
  const withUs = computeMapLayout([
    { key: "h1", lngLat: [114.2, 22.3] }, { key: "h2", lngLat: [113.3, 23.1] }, { key: "h9", lngLat: [-118.24, 34.05] },
  ], mercatorProjector([180, 28], 1.2, container), { clusterRadius: 28 });
  assert.equal(withUs.groups.length, 1);
  assert.deepEqual(withUs.groups[0].keys, ["h1", "h2"]);
  assert.equal(withUs.pos.h9.clusterId, null);
  assert.deepEqual(withUs.pos.h1.lngLat, withUs.groups[0].center, "组员的位置就是组心，弧线从这里连到美国");
});

test("absorb：紧挨着组的环、按圆心距离够不着的那台也并进组里", () => {
  const points = [
    { key: "h1", lngLat: [0, 0] as LngLat }, { key: "h2", lngLat: [1, 0] as LngLat },
    // 离组心 36px：超过 28 的分组半径，但 pill 半宽 30 + 圆盘 13 会压上
    { key: "h3", lngLat: [4.1, 0] as LngLat },
    { key: "h4", lngLat: [12, 0] as LngLat },
  ];
  const plain = computeMapLayout(points, project, { clusterRadius: 28 });
  assert.equal(plain.pos.h3.clusterId, null);
  const absorbed = computeMapLayout(points, project, { clusterRadius: 28, absorb: (_keys, d) => Math.abs(d.dx) < 30 + 13 && Math.abs(d.dy) < 11 + 13 });
  assert.equal(absorbed.groups.length, 1);
  assert.deepEqual(absorbed.groups[0].keys, ["h1", "h2", "h3"]);
  assert.equal(absorbed.pos.h4.clusterId, null, "远的那台不受影响");
});
