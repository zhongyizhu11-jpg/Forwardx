import assert from "node:assert/strict";
import test from "node:test";

import { buildNetworkMapModel } from "./networkMapModel";
import { computeMapLayout, type LngLat, type PixelBox, type PixelPoint } from "@shared/networkMapGeometry";

import { MINI_CAP_MIN_ARC_PX, MINI_FIT_MAX_ZOOM, detectWebGL, groupPlaceLabel, groupTipText, hostTipText, linkTipText, locatedHostCount, miniGroupLayoutOptions, miniMinZoom, placeLabelBoxes, shouldRefit, shouldRenderRealMap, unlocatedHostCount, type LabelItem } from "./networkMapMini";

const now = 1_700_000_000_000;
const host = (id: number, geo?: [number, number]) => ({
  id, name: `h${id}`, isOnline: true, lastHeartbeat: now - 1000,
  ...(geo ? { geoLatitudeMicro: Math.round(geo[0] * 1e6), geoLongitudeMicro: Math.round(geo[1] * 1e6) } : {}),
});

test("定位到的 / 没坐标的主机各几台（没坐标的在角上写「N 台未定位」）", () => {
  const model = buildNetworkMapModel({
    now,
    hosts: [host(1, [22.32, 114.17]), host(2, [35.68, 139.65]), host(3)],
    tunnels: [{ id: 1, name: "t", mode: "forwardx", isEnabled: true, entryHostId: 1, exitHostId: 2 }],
  });
  assert.equal(locatedHostCount(model), 2);
  assert.equal(unlocatedHostCount(model), 1);
});

test("画真地图的条件：有 WebGL 且至少一台主机定位到了；node 里没有 WebGL", () => {
  assert.equal(shouldRenderRealMap({ webgl: true, locatedHosts: 1 }), true);
  assert.equal(shouldRenderRealMap({ webgl: true, locatedHosts: 0 }), false, "一台都没定位：示意图");
  assert.equal(shouldRenderRealMap({ webgl: false, locatedHosts: 3 }), false, "没有 WebGL：示意图");
  assert.equal(detectWebGL(), false);
});

test("常量：最多放到 9 级，110px 以上才挂中断的 ⊗；用户最多能缩到框好的再小一级", () => {
  assert.equal(MINI_FIT_MAX_ZOOM, 9);
  assert.equal(MINI_CAP_MIN_ARC_PX, 110);
  assert.equal(miniMinZoom(3.4), 2.4);
  assert.equal(miniMinZoom(0.6), 0, "不会小于 0");
});

test("什么时候重新框：首次、回到全览一定框；卡片变宽、主机集合变了只在用户没动过图时框", () => {
  assert.equal(shouldRefit("initial", false), true);
  assert.equal(shouldRefit("initial", true), true);
  assert.equal(shouldRefit("reset", true), true);
  assert.equal(shouldRefit("resize", false), true);
  assert.equal(shouldRefit("hosts", false), true);
  assert.equal(shouldRefit("resize", true), false, "用户拖到想看的地方，转屏不抢回视角");
  assert.equal(shouldRefit("hosts", true), false, "轮询回来多了台主机也不抢");
});

test("点一下的提示：主机写名字、地区、在不在线；线路写两端和延迟；组写地区和台数", () => {
  assert.equal(hostTipText({ name: "HK entry 01", region: "香港 · Central", city: "香港", isOnline: true }), "HK entry 01 · 香港 · Central · 在线");
  assert.equal(hostTipText({ name: "JP", region: null, city: "东京", isOnline: false }), "JP · 东京 · 离线");
  assert.equal(hostTipText({ name: "solo", region: null, city: "solo", isOnline: true }), "solo · 在线", "地区就是主机名时不重复");
  const nodes = [{ id: 1, name: "HK" }, { id: 2, name: "SG" }, { id: 3, name: "JP" }];
  assert.equal(linkTipText({ path: [1, 2, 3], latencyMs: 67.6, health: "healthy" }, nodes), "HK → JP · 68 ms");
  assert.equal(linkTipText({ path: [1, 3], latencyMs: null, health: "down" }, nodes), "HK → JP · 故障");
  assert.equal(linkTipText({ path: [1, 9], health: "standby" }, nodes), "HK → #9 · 待命");
  assert.equal(groupTipText("香港 · 深圳", 5), "香港 · 深圳 · 5 台");
});

const overlap = (a: PixelBox, b: PixelBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("名字不互压：挨着的两台翻到两侧、再挤就左右挪或缩小字号；贴边的往里挪", () => {
  const area = { x: 0, y: 0, w: 390, h: 300 };
  // 障碍是 26px 的圆盘本身（光晕是半透明的，名字擦到一点无妨）
  const disc = (x: number, y: number) => ({ x: x - 13, y: y - 13, w: 26, h: 26 });
  // 三台横着排、间距 34px（刚好不并组），名字 80px 宽
  const items: LabelItem[] = [
    { key: "a", x: 120, y: 100, w: 80, h: 14, tightW: 72, gap: 15 },
    { key: "b", x: 154, y: 102, w: 80, h: 14, tightW: 72, gap: 15 },
    { key: "c", x: 188, y: 104, w: 80, h: 14, tightW: 72, gap: 15 },
    // 悉尼贴着右边
    { key: "d", x: 372, y: 260, w: 60, h: 14, tightW: 54, gap: 15 },
  ];
  const obstacles = items.map((item) => disc(item.x, item.y));
  const placed = placeLabelBoxes(items, obstacles, area);
  assert.equal(placed.length, 4);
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) assert.ok(!overlap(placed[i].box, placed[j].box), `${placed[i].key} 压着 ${placed[j].key}`);
    for (const box of obstacles) assert.ok(!overlap(placed[i].box, box), `${placed[i].key} 压着圆盘`);
    const box = placed[i].box;
    assert.ok(box.x >= 0 && box.x + box.w <= 390, `${placed[i].key} 出界 ${JSON.stringify(box)}`);
  }
  const byKey = Object.fromEntries(placed.map((item) => [item.key, item]));
  assert.notEqual(byKey.a.up, byKey.b.up, "相邻两台一上一下");
  assert.ok(byKey.d.dx < 0, "贴右边的往左挪");
  // preferUp：先试上面
  const up = placeLabelBoxes([{ key: "top", x: 100, y: 60, w: 40, h: 14, tightW: 36, gap: 15, preferUp: true }], [], area);
  assert.equal(up[0].up, true);
});

/** 墨卡托投影（和 MapLibre 一样 512px 一张世界图）：center 落在容器正中 */
function projector(center: LngLat, zoom: number, container: { width: number; height: number }) {
  const world = 512 * 2 ** zoom;
  const toWorld = (p: LngLat) => {
    const sin = Math.sin((p[1] * Math.PI) / 180);
    return { x: ((p[0] + 180) / 360) * world, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * world };
  };
  const c = toWorld(center);
  return (p: LngLat): PixelPoint => { const w = toWorld(p); return { x: w.x - c.x + container.width / 2, y: w.y - c.y + container.height / 2 }; };
}

type TopoHost = { id: number; lngLat: LngLat; flag: string; city: string };
/** 本地截图用的八台：港深广莞 + 东京 + 新加坡 + 洛杉矶 + 悉尼 */
const DENSE: TopoHost[] = [
  { id: 1, lngLat: [114.169, 22.319], flag: "HK", city: "Central" },
  { id: 2, lngLat: [139.65, 35.676], flag: "JP", city: "Tokyo" },
  { id: 3, lngLat: [103.85, 1.29], flag: "SG", city: "Singapore" },
  { id: 4, lngLat: [-118.244, 34.052], flag: "US", city: "Los Angeles" },
  { id: 5, lngLat: [114.058, 22.543], flag: "CN", city: "Shenzhen" },
  { id: 6, lngLat: [113.264, 23.129], flag: "CN", city: "Guangzhou" },
  { id: 7, lngLat: [113.752, 23.021], flag: "CN", city: "Dongguan" },
  { id: 8, lngLat: [151.209, -33.868], flag: "AU", city: "Sydney" },
];
/** 用户的拓扑：港粤台五台 + 悉尼一台 */
const USER: TopoHost[] = [
  { id: 1, lngLat: [114.2, 22.3], flag: "HK", city: "香港" },
  { id: 2, lngLat: [113.3, 23.1], flag: "CN", city: "广东" },
  { id: 3, lngLat: [121.5, 25.0], flag: "TW", city: "台湾" },
  { id: 4, lngLat: [114.0, 22.5], flag: "HK", city: "香港" },
  { id: 5, lngLat: [113.6, 22.9], flag: "CN", city: "广东" },
  { id: 6, lngLat: [151.2, -33.9], flag: "AU", city: "悉尼" },
];

/** 按首页地图的并组规则布局，返回组（含组员的真实像素位置） */
function groupsAt(hosts: readonly TopoHost[], project: (p: LngLat) => PixelPoint) {
  const flagOf = new Map(hosts.map((item) => [`h${item.id}`, item.flag]));
  const layout = computeMapLayout(hosts.map((item) => ({ key: `h${item.id}`, lngLat: item.lngLat })), project, miniGroupLayoutOptions(flagOf));
  const byKey = new Map(hosts.map((item) => [`h${item.id}`, item]));
  return {
    layout,
    groups: layout.groups.map((group) => ({
      hostIds: group.keys.map((key) => Number(key.slice(1))),
      members: group.keys.map((key) => project(byKey.get(key)!.lngLat)),
      label: groupPlaceLabel(group.keys.map((key) => byKey.get(key)!.city)),
    })),
  };
}

test("并组：八台拓扑的手机卡片上港深广莞四台并成一组（组名写前三个城市），东京单独画", () => {
  const container = { width: 340, height: 300 };
  const zoom = 0.2;
  const { groups } = groupsAt(DENSE, projector([165, 15], zoom, container));
  const main = groups.find((group) => group.hostIds.includes(1))!;
  assert.deepEqual([...main.hostIds].sort(), [1, 5, 6, 7], "四台一组，东京单独一枚");
  assert.ok(groups.every((group) => !group.hostIds.includes(2)), "东京不在任何组里");
  assert.equal(main.label, "Central · Shenzhen · Guangzhou");
});

test("并组：用户的港粤台 + 悉尼，全览时港粤台并成一组、悉尼单独；放大到港粤之后台北分出来", () => {
  const container = { width: 340, height: 300 };
  const far = groupsAt(USER, projector([132, -6], 1.6, container));
  const hk = far.groups.find((group) => group.hostIds.includes(1))!;
  assert.ok(hk.hostIds.includes(2) && hk.hostIds.includes(4) && hk.hostIds.includes(5), "港粤几台在一组");
  assert.ok(far.groups.every((group) => !group.hostIds.includes(6)), "悉尼单独");
  // 点组之后框住这组（6 级上下）：台北和港粤隔开了几百像素，自己一枚
  const near = groupsAt(USER, projector([117.5, 23.6], 6, container));
  assert.ok(near.groups.every((group) => !group.hostIds.includes(3)), "台北单独");
});

test("名字上下都摆不下时摆到圆盘旁边（离卡片边远的那侧先试）；不给 sideGap 就不试", () => {
  const disc = (x: number, y: number): PixelBox => ({ x: x - 13, y: y - 13, w: 26, h: 26 });
  // 上面一条、下面一条把上下都堵死；左右空着
  const walls: PixelBox[] = [{ x: 30, y: 40, w: 100, h: 24 }, { x: 30, y: 104, w: 100, h: 26 }, disc(60, 84)];
  const item: LabelItem = { key: "dg", x: 60, y: 84, w: 58, h: 20, tightW: 52, gap: 15, sideGap: 16 };
  const area: PixelBox = { x: 0, y: 0, w: 176, h: 186 };
  const [side] = placeLabelBoxes([item], walls, area);
  assert.equal(side.side, "right", "圆盘在卡片左半边：先试右边");
  assert.equal(side.box.x, 60 + 16);
  assert.equal(side.dx, 16, "dx 是名字左边缘离锚点多远");
  assert.ok(Math.abs(side.box.y + side.box.h / 2 - 84) < 1e-9, "竖直居中在锚点上");
  for (const wall of walls) assert.ok(!overlap(side.box, wall));
  // 靠右的圆盘先试左边
  const right = placeLabelBoxes([{ ...item, x: 150 }], [{ x: 110, y: 40, w: 60, h: 24 }, { x: 110, y: 104, w: 60, h: 26 }, disc(150, 84)], area);
  assert.equal(right[0].side, "left");
  // 不给 sideGap：只在上下找，挑压得最少的那个（不会摆到旁边）
  const { sideGap: _unused, ...plain } = item;
  assert.equal(placeLabelBoxes([plain], walls, area)[0].side, undefined);
});

test("名字两行（城市 + 延迟）摆不下时退成只写城市；摆得下就留着延迟", () => {
  const area: PixelBox = { x: 0, y: 0, w: 300, h: 200 };
  const item: LabelItem = { key: "h1", x: 150, y: 100, w: 40, h: 28, tightW: 36, gap: 10, short: { w: 30, h: 14, tightW: 27 } };
  // 空地：两行照摆
  assert.equal(placeLabelBoxes([item], [], area)[0].short, undefined);
  // 上下各 26px 外就是别的东西（两行 28px 高放不下，一行 14px 放得下），左右也被挡住
  const walls: PixelBox[] = [{ x: 0, y: 126, w: 300, h: 74 }, { x: 0, y: 0, w: 300, h: 74 }, { x: 0, y: 74, w: 128, h: 52 }, { x: 172, y: 74, w: 128, h: 52 }];
  const tightItem = { ...item, sideGap: 13 };
  const placed = placeLabelBoxes([tightItem], walls, area)[0];
  assert.equal(placed.short, true, "一行摆得下：城市名留着，延迟那行去掉");
  assert.equal(placed.box.h, 14);
});
