import assert from "node:assert/strict";
import test from "node:test";

import { computeMapLayout, unionBox, type FitItem, type LngLat, type PixelBox, type PixelPoint } from "@shared/networkMapGeometry";

import {
  PAGE_FIT_EDGE_PX,
  canAutoFit,
  paddedCenter,
  paddingForOverlays,
  settlePaddedFit,
  sheetOverlayBox,
  visibleArea,
} from "./networkMapOverlays";
import type { MapPadding } from "./networkMapPageState";

/*
  用一台「假地图」模拟整页画布的精确框住：Web 墨卡托投影、MapLibre 的留白语义（center 画在留白矩形正中）、
  和 marker 同步时一样的 smartWrap（离中心经度超过 180° 的点挪到另一份世界），布局用画布同一个
  computeMapLayout（6 级以下 44px 内聚簇）。marker 的盒子按 networkMap.css 的尺寸：主机 / 落地是 18px 的环、
  簇是 26px 的环，名字在环右边（环半径 + 7px），两行 29px 高、簇一行 15px —— 名字一律按摆在右边算，
  比画布（右边放不下会换到左边）更严。
*/

type Camera = { lng: number; lat: number; zoom: number };
const mercX = (lng: number) => (lng + 180) / 360;
const mercY = (lat: number) => {
  const rad = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
};
const unmercY = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

function makeMap(size: { width: number; height: number }, padding: MapPadding, camera: Camera) {
  const pc = paddedCenter(size, padding);
  const world = () => 512 * 2 ** camera.zoom;
  const project = (lngLat: LngLat): PixelPoint => {
    let lng = lngLat[0];
    while (lng - camera.lng > 180) lng -= 360;
    while (lng - camera.lng < -180) lng += 360;
    return { x: pc.x + (mercX(lng) - mercX(camera.lng)) * world(), y: pc.y + (mercY(lngLat[1]) - mercY(camera.lat)) * world() };
  };
  const unproject = (point: PixelPoint) => ({
    lng: camera.lng + ((point.x - pc.x) / world()) * 360,
    lat: unmercY(mercY(camera.lat) + (point.y - pc.y) / world()),
  });
  return {
    camera,
    project,
    jump(centerPx: PixelPoint, zoom: number) {
      const at = unproject(centerPx);
      camera.lng = at.lng;
      camera.lat = at.lat;
      camera.zoom = zoom;
    },
  };
}

type Marker = { key: string; lngLat: LngLat; label: { w: number; h: number } };

/** 一次布局：每个 marker（单台 / 落地 / 簇）的锚点和「环 + 名字」的盒子 */
function layoutItems(map: ReturnType<typeof makeMap>, markers: readonly Marker[], clusterLabelW: number) {
  const layout = computeMapLayout(markers.map((m) => ({ key: m.key, lngLat: m.lngLat })), (lngLat) => map.project(lngLat), map.camera.zoom);
  const items: Array<FitItem & { key: string }> = [];
  for (const marker of markers) {
    const position = layout.pos[marker.key];
    if (!position || position.clusterId !== null) continue;
    const anchor = map.project(position.lngLat);
    const at = { x: anchor.x + position.offset[0], y: anchor.y + position.offset[1] };
    const ring: PixelBox = { x: at.x - 10, y: at.y - 10, w: 20, h: 20 };
    const name: PixelBox = { x: at.x + 9 + 7, y: at.y - marker.label.h / 2, w: marker.label.w, h: marker.label.h };
    items.push({ key: marker.key, anchor, box: unionBox([ring, name])! });
  }
  for (const group of layout.groups) {
    const anchor = map.project(group.center);
    const ring: PixelBox = { x: anchor.x - 14, y: anchor.y - 14, w: 28, h: 28 };
    const name: PixelBox = { x: anchor.x + 13 + 7, y: anchor.y - 7.5, w: clusterLabelW, h: 15 };
    items.push({ key: `g:${group.keys.join(",")}`, anchor, box: unionBox([ring, name])! });
  }
  return items;
}

const overlaps = (a: PixelBox, b: PixelBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 用户的拓扑：港粤台七台（并成一枚「7」）、悉尼一台、洛杉矶一个落地目标 */
const USER_TOPOLOGY: Marker[] = [
  { key: "h1", lngLat: [114.1747, 22.2783], label: { w: 30, h: 29 } },
  { key: "h2", lngLat: [114.1747, 22.2783], label: { w: 30, h: 29 } },
  { key: "h3", lngLat: [114.1694, 22.3193], label: { w: 30, h: 29 } },
  { key: "h4", lngLat: [113.25, 23.1167], label: { w: 30, h: 29 } },
  { key: "h5", lngLat: [113.25, 23.1167], label: { w: 30, h: 29 } },
  { key: "h6", lngLat: [121.5319, 25.0478], label: { w: 30, h: 29 } },
  { key: "h7", lngLat: [121.5654, 25.033], label: { w: 30, h: 29 } },
  { key: "h8", lngLat: [151.2006, -33.8715], label: { w: 40, h: 29 } },
  { key: "t:la", lngLat: [-118.2437, 34.0522], label: { w: 40, h: 29 } },
];
/** 「香港 · 广州 · 台北」：六个 12px 的汉字 + 两个分隔点 */
const CLUSTER_LABEL_W = 96;

/** 手机 390×844 上的浮层：一行标题、一行四个小胶囊、右下竖着的工具栏、左下「图例」小条、收起的抽屉 */
const PHONE = { width: 390, height: 844 };
const PHONE_OVERLAYS: PixelBox[] = [
  { x: 12, y: 10, w: 72, h: 20 },
  { x: 12, y: 36, w: 316, h: 28 },
  { x: 334, y: 590, w: 44, h: 160 },
  { x: 12, y: 722, w: 86, h: 28 },
  sheetOverlayBox("peek", PHONE),
];

/** 桌面 1280×820：标题和四张统计卡在左上、底图切换在右上、工具栏在右边、图例卡在左下 */
const DESKTOP = { width: 1280, height: 820 };
const DESKTOP_OVERLAYS: PixelBox[] = [
  { x: 16, y: 16, w: 210, h: 42 },
  { x: 16, y: 70, w: 640, h: 58 },
  { x: 1000, y: 16, w: 264, h: 36 },
  { x: 1202, y: 64, w: 62, h: 230 },
  { x: 16, y: 694, w: 168, h: 110 },
];

function runFit(size: { width: number; height: number }, overlays: PixelBox[], start: Camera) {
  const padding = paddingForOverlays(size, overlays);
  const map = makeMap(size, padding, { ...start });
  const result = settlePaddedFit({
    size,
    padding,
    measure: () => layoutItems(map, USER_TOPOLOGY, CLUSTER_LABEL_W),
    zoom: () => map.camera.zoom,
    jump: (centerPx, zoom) => map.jump(centerPx, Math.max(0, zoom)),
    maxZoom: 5,
    minZoom: 0,
  });
  return { padding, map, result, items: layoutItems(map, USER_TOPOLOGY, CLUSTER_LABEL_W) };
}

function assertAllVisible(size: { width: number; height: number }, overlays: PixelBox[], fit: ReturnType<typeof runFit>) {
  const area = visibleArea(size, fit.padding);
  const tolerance = 0.5;
  assert.ok(fit.items.length >= 3, "至少画出簇、悉尼、洛杉矶三枚");
  for (const item of fit.items) {
    const { box } = item;
    const label = (item as { key?: string }).key;
    assert.ok(box.x >= -tolerance && box.y >= -tolerance && box.x + box.w <= size.width + tolerance && box.y + box.h <= size.height + tolerance, `${label} 整个在容器里：${JSON.stringify(box)}`);
    assert.ok(box.x >= area.x - tolerance && box.y >= area.y - tolerance && box.x + box.w <= area.x + area.w + tolerance && box.y + box.h <= area.y + area.h + tolerance, `${label} 整个在留白后的可视区里：${JSON.stringify(box)} / ${JSON.stringify(area)}`);
    for (const overlay of overlays) assert.ok(!overlaps(box, overlay), `${label} 不压在浮层底下：${JSON.stringify(box)} × ${JSON.stringify(overlay)}`);
  }
}

test("手机浮层的留白：标题和小胶囊归顶边，工具栏归右边，图例小条和抽屉归底边", () => {
  const padding = paddingForOverlays(PHONE, PHONE_OVERLAYS);
  assert.deepEqual(padding, { top: 72, right: 64, bottom: 130, left: 0 });
  // 手机上的控件（不算抽屉）最多占地图高度的四分之一
  const chrome = padding.top + (padding.bottom - (PHONE.height - sheetOverlayBox("peek", PHONE).y));
  assert.ok(chrome <= PHONE.height * 0.25, `控件占了 ${chrome}px`);
});

test("抽屉升到半屏：底边的留白跟着抽屉走，矩形还够框；拉到全屏就不再自动框", () => {
  const half = paddingForOverlays(PHONE, [...PHONE_OVERLAYS.slice(0, 2), sheetOverlayBox("half", PHONE)]);
  assert.equal(half.bottom, Math.round(PHONE.height * 0.48) + 8);
  assert.ok(canAutoFit(PHONE, half));
  const full = paddingForOverlays(PHONE, [...PHONE_OVERLAYS.slice(0, 2), sheetOverlayBox("full", PHONE)]);
  assert.equal(canAutoFit(PHONE, full), false);
});

test("桌面浮层的留白：顶上让出标题和统计卡，右边让出工具栏，详情卡开着时再让出它", () => {
  const closed = paddingForOverlays(DESKTOP, DESKTOP_OVERLAYS);
  assert.equal(closed.top, 136);
  assert.equal(closed.right, 1280 - 1202 + 8);
  const open = paddingForOverlays(DESKTOP, [...DESKTOP_OVERLAYS.map((box) => (box.x > 900 ? { ...box, x: box.x - 400 } : box)), { x: 880, y: 16, w: 384, h: 788 }]);
  assert.equal(open.right, 1280 - (1202 - 400) + 8);
});

test("用户的拓扑在手机 390×844 上框住：簇的环、悉尼、洛杉矶的落地都整个看得见，不压在任何浮层底下", () => {
  // 从页面一打开的默认视角（东亚上空、1.6 级）开始框
  const fit = runFit(PHONE, PHONE_OVERLAYS, { lng: 110, lat: 25, zoom: 1.6 });
  assert.ok(fit.result.fits, "缩到 0 级以内放得下");
  assert.ok(fit.map.camera.zoom > 0 && fit.map.camera.zoom < 1.6, `缩放 ${fit.map.camera.zoom}`);
  assertAllVisible(PHONE, PHONE_OVERLAYS, fit);
  // 港粤台那一组是一枚簇，不贴着左边缘（以前环被切掉半个）
  const cluster = fit.items.find((item) => (item as { key: string }).key.startsWith("g:"));
  assert.ok(cluster, "港粤台并成一枚簇");
  assert.ok(cluster!.box.x >= PAGE_FIT_EDGE_PX - 0.5);
});

test("同一拓扑：从别的视角开始框（已经放大过、在美洲上空）也收敛到同样都看得见", () => {
  assertAllVisible(PHONE, PHONE_OVERLAYS, runFit(PHONE, PHONE_OVERLAYS, { lng: -100, lat: 40, zoom: 4 }));
  assertAllVisible(PHONE, PHONE_OVERLAYS, runFit(PHONE, PHONE_OVERLAYS, { lng: 150, lat: -30, zoom: 0.3 }));
});

test("同一拓扑在桌面 1280×820 上框住：都看得见，而且比手机放得更大", () => {
  const desk = runFit(DESKTOP, DESKTOP_OVERLAYS, { lng: 110, lat: 25, zoom: 1.6 });
  assertAllVisible(DESKTOP, DESKTOP_OVERLAYS, desk);
  const phone = runFit(PHONE, PHONE_OVERLAYS, { lng: 110, lat: 25, zoom: 1.6 });
  assert.ok(desk.map.camera.zoom > phone.map.camera.zoom);
});

test("手机上抽屉在半屏：剩下那块里照样都看得见", () => {
  const overlays = [...PHONE_OVERLAYS.slice(0, 2), { x: 334, y: 844 - 405 - 10 - 160, w: 44, h: 160 }, { x: 12, y: 844 - 405 - 10 - 28, w: 86, h: 28 }, sheetOverlayBox("half", PHONE)];
  assertAllVisible(PHONE, overlays, runFit(PHONE, overlays, { lng: 110, lat: 25, zoom: 1.6 }));
});
