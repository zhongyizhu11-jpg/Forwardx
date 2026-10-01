import assert from "node:assert/strict";
import test from "node:test";

import { buildNetworkMapModel } from "./networkMapModel";
import { computeMapLayout, type LngLat, type PixelBox, type PixelPoint } from "@shared/networkMapGeometry";

import { INSET_LABEL_MARGIN_PX, MINI_CAP_MIN_ARC_PX, MINI_FIT_MAX_ZOOM, MINI_GROUP_RADIUS_PX, cornerBox, densestInsetMembers, detectWebGL, nextInsetGrowStage, groupCoverageBox, groupPlaceLabel, groupTipText, hostTipText, insetLabelArea, insetLeader, insetSizes, linkTipText, locatedHostCount, matchInsetGroup, miniFitPoints, miniGroupLayoutOptions, miniMinZoom, pickInsetGroups, pickInsetSlots, pickInsetZoom, placeInsetLabels, placeInsets, placeLabelBoxes, scoreQuadrants, shouldAbsorbIntoGroup, shouldRefit, shouldRenderRealMap, unlocatedHostCount, type LabelItem } from "./networkMapMini";

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

test("小图的常量：最多放到 9 级，110px 以上才挂延迟小牌子；用户最多能缩到框好的再小一级", () => {
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

test("钉住的小窗跟主图上的哪一组：组员一个不少才算；放大到散开了就没有；缩小并进更多台也算", () => {
  const groups = [{ hostIds: [1, 2, 3], label: "港" }, { hostIds: [7, 8], label: "日" }];
  assert.equal(matchInsetGroup([1, 2, 3], groups), groups[0]);
  assert.equal(matchInsetGroup([1, 2], groups), groups[0], "缩小后组里多了台也还是它");
  assert.equal(matchInsetGroup([1, 2, 3, 4], groups), null, "少了一台：散了");
  assert.equal(matchInsetGroup([1, 2, 3], [{ hostIds: [1, 2] }, { hostIds: [3] }]), null, "拆成两组：散了");
  assert.equal(matchInsetGroup([], groups), null);
});

test("引线：圈在图内才拉；整个滚出图外就不拉（小窗还在）", () => {
  const container = { width: 390, height: 300 };
  const panel = { x: 10, y: 150, w: 170, h: 140 };
  const inside = insetLeader({ x: 250, y: 40, w: 60, h: 40 }, panel, container);
  assert.ok(inside && inside.length === 2);
  assert.equal(insetLeader({ x: -200, y: 40, w: 60, h: 40 }, panel, container), null, "圈滚到左边外面");
  assert.equal(insetLeader({ x: 100, y: 320, w: 60, h: 40 }, panel, container), null, "圈滚到底下外面");
  assert.ok(insetLeader({ x: -30, y: 40, w: 60, h: 40 }, panel, container), "露出一半还拉");
  assert.equal(insetLeader(null, panel, container), null);
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

test("小窗摆到最空的象限：港粤在左上、悉尼在右下时去左下；压到 marker 就换角、再不行缩小", () => {
  const container = { width: 390, height: 300 };
  const occupancy = {
    boxes: [{ x: 100, y: 12, w: 70, h: 50 }, { x: 240, y: 240, w: 34, h: 50 }],
    points: Array.from({ length: 30 }, (_, i) => ({ x: 135 + i * 4, y: 40 + i * 7 })),
  };
  const scores = scoreQuadrants(container, occupancy);
  assert.ok(scores.bl < scores.tl && scores.bl < scores.br, JSON.stringify(scores));
  const [inset] = placeInsets(container, occupancy, 1, false);
  assert.equal(inset.quadrant, "bl");
  assert.equal(inset.shrunk, false);
  assert.deepEqual({ w: inset.box.w, h: inset.box.h }, insetSizes(container, false).full);
  assert.ok(inset.box.x >= 10 && inset.box.y + inset.box.h <= 290, "在卡片留白之内");
  for (const box of occupancy.boxes) assert.ok(!overlap(inset.box, box), "不盖住 marker");
  // 左下角本身有台主机：换到下一个空角
  const busy = { ...occupancy, boxes: [...occupancy.boxes, { x: 20, y: 250, w: 34, h: 40 }] };
  const [moved] = placeInsets(container, busy, 1, false);
  assert.notEqual(moved.quadrant, "bl");
  for (const box of busy.boxes) assert.ok(!overlap(moved.box, box));
  // 四个角都有主机：缩到最小尺寸
  const crowded = { boxes: [{ x: 20, y: 20, w: 40, h: 40 }, { x: 330, y: 20, w: 40, h: 40 }, { x: 20, y: 240, w: 40, h: 40 }, { x: 330, y: 240, w: 40, h: 40 }], points: [] };
  const [small] = placeInsets(container, crowded, 1, false);
  assert.equal(small.shrunk, true);
  assert.deepEqual({ w: small.box.w, h: small.box.h }, insetSizes(container, false).min);
  // 桌面两个小窗：不同的角、互不相压
  const desk = { width: 1054, height: 380 };
  const two = placeInsets(desk, { boxes: [{ x: 300, y: 20, w: 70, h: 50 }, { x: 700, y: 300, w: 34, h: 50 }], points: [] }, 2, true);
  assert.equal(two.length, 2);
  assert.notEqual(two[0].quadrant, two[1].quadrant);
  assert.ok(!overlap(two[0].box, two[1].box));
  assert.deepEqual({ w: two[0].box.w, h: two[0].box.h }, insetSizes(desk, true).full);
});

test("角上有 + / − 或「N 台未定位」时小窗往里挪到不压它：挑挪得少的方向；没有就贴角", () => {
  const container = { width: 390, height: 300 };
  const size = { w: 160, h: 170 };
  assert.deepEqual(cornerBox(container, "br", size, 10), { x: 220, y: 120, w: 160, h: 170 });
  // 右下角 36×68 的缩放键：往左挪 36（盒子右边 380 − 键左边 344）比往上挪 68（盒子底 290 − 键顶 222）少
  const zoom = { x: 344, y: 222, w: 36, h: 68 };
  assert.deepEqual(cornerBox(container, "br", size, 10, [zoom]), { x: 184, y: 120, w: 160, h: 170 });
  // 右上角一条 90×24 的标签：往下挪 24 比往左挪 90 少
  const label = { x: 290, y: 4, w: 90, h: 24 };
  assert.deepEqual(cornerBox(container, "tr", size, 10, [label]), { x: 220, y: 28, w: 160, h: 170 });
  // 不相交的不管
  assert.deepEqual(cornerBox(container, "bl", size, 10, [zoom, label]), { x: 10, y: 120, w: 160, h: 170 });
  // placeInsets 里同样生效：四个角都空、右下的键在，左下优先本来就不碰它；逼到右下时挪开
  const busy = { boxes: [{ x: 10, y: 10, w: 120, h: 120 }, { x: 260, y: 10, w: 120, h: 120 }, { x: 10, y: 170, w: 120, h: 120 }], points: [], reserved: [zoom] };
  const [placed] = placeInsets(container, busy, 1, false);
  assert.equal(placed.quadrant, "br");
  assert.ok(!overlap(placed.box, zoom), JSON.stringify(placed.box));
});

test("覆盖框、选哪几组开小窗", () => {
  assert.deepEqual(groupCoverageBox([{ x: 100, y: 40 }, { x: 110, y: 50 }], { x: 80, y: 32, w: 50, h: 24 }, 5), { x: 75, y: 27, w: 60, h: 34 });
  assert.equal(groupCoverageBox([], null), null);
  const groups = [{ hostIds: [7] }, { hostIds: [3, 4] }, { hostIds: [1, 2, 5, 6] }, { hostIds: [8, 9] }];
  assert.deepEqual(pickInsetGroups(groups, false).map((g) => g.hostIds), [[1, 2, 5, 6]]);
  assert.deepEqual(pickInsetGroups(groups, true).map((g) => g.hostIds), [[1, 2, 5, 6], [3, 4]]);
  assert.equal(MINI_GROUP_RADIUS_PX, 28);
  // 两面旗、数字 4：一摞 40px 宽、半宽 20；紧挨着右边 36px 的那台并进来，上下 40px 的不并
  assert.ok(shouldAbsorbIntoGroup(2, 4, { dx: 36, dy: 4 }));
  assert.ok(!shouldAbsorbIntoGroup(2, 4, { dx: 60, dy: 4 }));
  assert.ok(!shouldAbsorbIntoGroup(2, 4, { dx: 10, dy: 40 }));
});

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
  // 环上的点：朝外的那侧优先
  const ring = placeLabelBoxes([{ key: "top", x: 100, y: 60, w: 40, h: 14, tightW: 36, gap: 15, preferUp: true }], [], area);
  assert.equal(ring[0].up, true);
});

// ---- 小窗：挑哪几台、窗里再并组、名字摆不下就藏 ----

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

/** 按主图 / 小窗同一套并组规则布局，返回组（含组员的真实像素位置） */
function groupsAt(hosts: readonly TopoHost[], project: (p: LngLat) => PixelPoint, zoom: number) {
  const flagOf = new Map(hosts.map((item) => [`h${item.id}`, item.flag]));
  const layout = computeMapLayout(hosts.map((item) => ({ key: `h${item.id}`, lngLat: item.lngLat })), project, zoom, miniGroupLayoutOptions(flagOf));
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

test("小窗挑组员：八台拓扑的手机主图上港深广莞四台一组（东京的点压不到窄了的那一摞，单独画），小窗框这四台", () => {
  const container = { width: 340, height: 300 };
  const zoom = 0.2;
  const { groups } = groupsAt(DENSE, projector([165, 15], zoom, container), zoom);
  const main = groups.find((group) => group.hostIds.includes(1))!;
  // 以前那条宽 pill 有 70px，东京的圆盘压在它右边被并进来；换成一摞国旗 + 数量牌（40px 上下）之后压不到了
  assert.deepEqual([...main.hostIds].sort(), [1, 5, 6, 7], "主图上四台一组，东京单独一枚");
  assert.ok(groups.every((group) => !group.hostIds.includes(2)), "东京不在任何组里");
  assert.deepEqual(densestInsetMembers(main), [1, 5, 6, 7], "小窗只框真正叠在一起的四台");
  const [slot] = pickInsetSlots(groups, false);
  assert.deepEqual(slot.hostIds, [1, 5, 6, 7]);
  assert.equal(slot.group, main, "圈和引线还跟着主图上的整组");
  // 标题按小窗真正框的几台写
  const cities = slot.hostIds.map((id) => DENSE.find((item) => item.id === id)!.city);
  assert.equal(groupPlaceLabel(cities), "Central · Shenzhen · Guangzhou");
});

test("小窗挑组员：用户的港粤台 + 悉尼，台北被 pill 吸进来时小窗框港粤四台；组员都挤在一起时整组照框", () => {
  const container = { width: 340, height: 300 };
  const zoom = 1.6;
  const { groups } = groupsAt(USER, projector([132, -6], zoom, container), zoom);
  const main = groups.find((group) => group.hostIds.includes(1))!;
  assert.ok(main.hostIds.includes(3), "台北压在 pill 上并进组");
  assert.deepEqual(densestInsetMembers(main), [1, 2, 4, 5]);
  // 主图缩放差一点、台北恰好离广州 26px（< 28 连得上）：连通半径往下收，还是只框港粤四台
  assert.deepEqual(densestInsetMembers({ hostIds: [1, 2, 3, 4, 5], members: [{ x: 100, y: 100 }, { x: 97, y: 98 }, { x: 123, y: 94 }, { x: 99, y: 99 }, { x: 98, y: 99 }] }), [1, 2, 4, 5]);
  // 四台两两都压在一起：不挑，整组
  assert.deepEqual(densestInsetMembers({ hostIds: [1, 2, 3, 4], members: [{ x: 0, y: 0 }, { x: 4, y: 3 }, { x: 8, y: 1 }, { x: 3, y: 7 }] }), [1, 2, 3, 4]);
  // 同一机房（同一个点）两台 + 一台 40px 外（被 pill 吸进来的）：一团的宽按至少 2px 算，挑出同机房两台
  assert.deepEqual(densestInsetMembers({ hostIds: [4, 5, 6], members: [{ x: 50, y: 50 }, { x: 50, y: 50 }, { x: 90, y: 50 }] }), [4, 5]);
  // 一串互相不压、只是被 pill 吸进来的：没有能框的一团，照框整组
  assert.deepEqual(densestInsetMembers({ hostIds: [1, 2, 3], members: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 60, y: 0 }] }), [1, 2, 3]);
  // 远的那台不算远（外接范围不到那一团的 4 倍）：整组
  assert.deepEqual(densestInsetMembers({ hostIds: [1, 2, 3], members: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 45, y: 0 }] }), [1, 2, 3]);
  // 两台的组不挑
  assert.deepEqual(densestInsetMembers({ hostIds: [7, 8], members: [{ x: 0, y: 0 }, { x: 40, y: 0 }] }), [7, 8]);
});

test("桌面两扇小窗：按真正挤在一起的台数排，一样多时更紧的在前", () => {
  const groups = [
    { hostIds: [1, 2], members: [{ x: 0, y: 0 }, { x: 20, y: 0 }] },
    { hostIds: [3, 4, 9], members: [{ x: 100, y: 0 }, { x: 102, y: 0 }, { x: 140, y: 0 }] },
    { hostIds: [5, 6], members: [{ x: 200, y: 0 }, { x: 201, y: 0 }] },
  ];
  assert.deepEqual(pickInsetSlots(groups, true).map((slot) => slot.hostIds), [[5, 6], [3, 4]]);
  assert.deepEqual(pickInsetSlots(groups, false).map((slot) => slot.hostIds), [[5, 6]]);
  // 台数多的在前：三台挤在一起的那组比两台的优先
  const three = { hostIds: [10, 11, 12], members: [{ x: 300, y: 0 }, { x: 310, y: 0 }, { x: 305, y: 8 }] };
  assert.deepEqual(pickInsetSlots([...groups, three], false).map((slot) => slot.hostIds), [[10, 11, 12]]);
});

test("小窗里再并组：要框的几台里有东京（窗放不大）时港深广莞在窗里并成一枚 pill，画在真正的组心", () => {
  // 手机小窗大约 156×174；框住港 ↔ 东京差不多是 2 级
  const inset = { width: 156, height: 174 };
  const zoom = 2;
  const { layout } = groupsAt(DENSE, projector([127, 29], zoom, inset), zoom);
  assert.equal(layout.mode, "cluster");
  const prd = layout.groups.find((group) => group.keys.includes("h1"))!;
  assert.deepEqual([...prd.keys].sort(), ["h1", "h5", "h6", "h7"]);
  const mean = (index: 0 | 1) => [1, 5, 6, 7].reduce((sum, id) => sum + DENSE.find((item) => item.id === id)!.lngLat[index], 0) / 4;
  assert.ok(Math.abs(prd.center[0] - mean(0)) < 1e-9 && Math.abs(prd.center[1] - mean(1)) < 1e-9, "pill 在组员真实坐标的平均处");
  assert.equal(layout.pos.h2.clusterId, null, "东京单独画");
  for (const key of Object.keys(layout.pos)) assert.deepEqual(layout.pos[key].offset, [0, 0], "谁都不错开成环");
  // 只框港深广莞时窗能放到 6.5 级上下：四台都分开，不并组
  const close = groupsAt(DENSE, projector([113.72, 22.72], 6.5, inset), 6.5);
  for (const id of [1, 5, 6, 7]) assert.equal(close.layout.pos[`h${id}`].clusterId, null);
  // 用户的拓扑：框港粤台时（约 4 级）港粤四台并成一枚、台北单独
  const user = groupsAt(USER, projector([117.5, 23.5], 4, inset), 4);
  assert.deepEqual([...user.layout.groups[0].keys].sort(), ["h1", "h2", "h4", "h5"]);
  assert.equal(user.layout.pos.h3.clusterId, null);
});

test("小窗的名字：以窗让出 8px 为边界、标题条是障碍；摆不干净的藏起来（不画成被切的、压着的）", () => {
  const size = { width: 156, height: 174 };
  assert.equal(INSET_LABEL_MARGIN_PX, 8);
  const area = insetLabelArea(size);
  assert.deepEqual(area, { x: 8, y: 8, w: 140, h: 158 });
  const title: PixelBox = { x: 1, y: 1, w: 150, h: 24 };
  const disc = (x: number, y: number): PixelBox => ({ x: x - 13, y: y - 13, w: 26, h: 26 });
  // 港深广莞在 6.5 级上的样子（只框这四台时窗放到的级别），名字按 10.5px 字粗算的宽
  const project = projector([113.72, 22.72], 6.5, size);
  const names: Record<number, string> = { 1: "HK entry 01", 5: "SZ relay 05", 6: "GZ relay 06", 7: "DG relay 07" };
  const items: LabelItem[] = [1, 5, 6, 7].map((id) => {
    const at = project(DENSE.find((item) => item.id === id)!.lngLat);
    return { key: `h${id}`, x: at.x, y: at.y, w: names[id].length * 6.4, h: 14, tightW: names[id].length * 5.8, gap: 15 };
  });
  const obstacles = [...items.map((item) => disc(item.x, item.y)), title];
  const placed = placeInsetLabels(items, obstacles, size);
  assert.equal(placed.length, 4);
  const shown = placed.filter((item) => !item.hidden);
  // 156px 宽的窗里摆四个 70px 的名字：摆得下的画、摆不下的藏，没有第三种
  assert.ok(shown.length >= 2 && shown.length < 4, `摆下一部分、藏一部分：${JSON.stringify(placed)}`);
  for (const item of shown) {
    const box = item.box;
    assert.ok(box.x >= area.x - 1e-6 && box.y >= area.y - 1e-6 && box.x + box.w <= area.x + area.w + 1e-6 && box.y + box.h <= area.y + area.h + 1e-6, `${item.key} 出了窗 ${JSON.stringify(box)}`);
    for (const other of obstacles) assert.ok(!overlap(box, other), `${item.key} 压着圆盘 / 标题`);
    for (const other of shown) if (other !== item) assert.ok(!overlap(box, other.box), `${item.key} 压着 ${other.key}`);
  }
  // 上下都被占满（上面一条胶囊、下面一排名字）：藏起来，不当后面的障碍
  const boxed: LabelItem[] = [{ key: "x", x: 78, y: 90, w: 80, h: 14, tightW: 72, gap: 15 }, { key: "y", x: 78, y: 150, w: 60, h: 14, tightW: 54, gap: 15 }];
  const walls: PixelBox[] = [{ x: 0, y: 55, w: 156, h: 22 }, { x: 0, y: 104, w: 156, h: 16 }, disc(78, 90), disc(78, 150)];
  const hid = placeInsetLabels(boxed, walls, size);
  const byKey = Object.fromEntries(hid.map((item) => [item.key, item]));
  assert.equal(byKey.x.hidden, true, "x 上下都没地方");
  assert.ok(!byKey.y.hidden, "y 翻到上面还摆得下");
  // 同样的输入不开 hideUnplaceable（主图精确框住时）：还是给一个压得最少的位置
  assert.ok(!placeLabelBoxes(boxed, walls, area)[0].hidden);
  // 贴着窗左边的名字往里挪到 8px 线以内，不被切
  const edge = placeInsetLabels([{ key: "e", x: 20, y: 80, w: 70, h: 14, tightW: 63, gap: 15 }], [disc(20, 80)], size);
  assert.ok(!edge[0].hidden && edge[0].box.x >= 8, JSON.stringify(edge[0]));
  // priority：要框的那几台先挑位置
  const prio = placeLabelBoxes([
    { key: "other", x: 78, y: 60, w: 60, h: 14, tightW: 54, gap: 15, priority: 1 },
    { key: "mine", x: 78, y: 110, w: 60, h: 14, tightW: 54, gap: 15, preferUp: true },
  ], [], area);
  assert.equal(prio[0].key, "mine");
});

test("手机小窗放大：同一个角上试 52% × 62%，压到主图 marker 就不放大", () => {
  const container = { width: 340, height: 300 };
  const sizes = insetSizes(container, false);
  assert.deepEqual(sizes.large, { w: Math.round(340 * 0.52), h: Math.round(300 * 0.62) });
  assert.deepEqual(insetSizes(container, true).large, insetSizes(container, true).full, "桌面不放大");
  const occupancy = { boxes: [{ x: 250, y: 20, w: 60, h: 40 }], points: [] };
  const [normal] = placeInsets(container, occupancy, 1, false);
  const [grown] = placeInsets(container, occupancy, 1, false, 10, [true]);
  assert.equal(grown.quadrant, normal.quadrant, "不换角");
  assert.equal(grown.grown, true);
  assert.deepEqual({ w: grown.box.w, h: grown.box.h }, sizes.large);
  // 放大后会压到的地方有台主机：保持标准尺寸
  const tight = { boxes: [...occupancy.boxes, { x: normal.box.x + normal.box.w + 4, y: normal.box.y + 20, w: 26, h: 26 }], points: [] };
  const [kept] = placeInsets(container, tight, 1, false, 10, [true]);
  assert.ok(!kept.grown);
  assert.deepEqual({ w: kept.box.w, h: kept.box.h }, sizes.full);
});

test("手机小窗放大的状态机：藏了名字才试放大，放大后都摆下才留着；尺寸对不上的旧报告不算；桌面不放大", () => {
  const normal = { w: 156, h: 174 };
  const large = { w: 177, h: 186 };
  // 画布比窗小 2px（1px 边框）
  const sizes = { normal, large };
  assert.equal(nextInsetGrowStage(undefined, { width: 154, height: 172, hiddenLabels: 0 }, sizes, false), undefined, "都摆下了：不放大");
  assert.equal(nextInsetGrowStage(undefined, { width: 154, height: 172, hiddenLabels: 2 }, sizes, false), "try");
  assert.equal(nextInsetGrowStage("try", { width: 154, height: 172, hiddenLabels: 2 }, sizes, false), "try", "放大前那一轮（ResizeObserver 的第一下）的报告不算");
  assert.equal(nextInsetGrowStage("try", { width: 175, height: 184, hiddenLabels: 0 }, sizes, false), "keep");
  assert.equal(nextInsetGrowStage("try", { width: 175, height: 184, hiddenLabels: 1 }, sizes, false), "no", "放大了也摆不下：缩回去");
  assert.equal(nextInsetGrowStage("no", { width: 154, height: 172, hiddenLabels: 1 }, sizes, false), "no", "不再来回试");
  assert.equal(nextInsetGrowStage("keep", { width: 175, height: 184, hiddenLabels: 0 }, sizes, false), "keep");
  assert.equal(nextInsetGrowStage(undefined, { width: 175, height: 184, hiddenLabels: 2 }, sizes, false), undefined, "尺寸对不上的报告不算");
  assert.equal(nextInsetGrowStage(undefined, { width: 354, height: 188, hiddenLabels: 3 }, { normal: { w: 356, h: 190 }, large: { w: 356, h: 190 } }, true), undefined, "桌面");
});

test("小窗挑缩放档：分开的圆盘优先，藏一个名字也不并；一个名字都没有时宁可并成两枚；圆盘出窗的档不要", () => {
  // 桌面：四台分开藏一个（3.4）好过并成三枚都有名字（3）
  assert.equal(pickInsetZoom([
    { zoom: 6.4, markers: 4, hidden: 1, valid: true },
    { zoom: 6.1, markers: 3, hidden: 0, valid: true },
  ]), 0);
  // 手机：四台分开但名字全藏（1.6）不如两枚 pill 名字都在（2）；全并成一枚（1）最后
  assert.equal(pickInsetZoom([
    { zoom: 6.4, markers: 4, hidden: 4, valid: true },
    { zoom: 5.9, markers: 3, hidden: 3, valid: true },
    { zoom: 5.4, markers: 2, hidden: 0, valid: true },
    { zoom: 4.9, markers: 1, hidden: 0, valid: true },
  ]), 2);
  // 一样好：挑放得更大的
  assert.equal(pickInsetZoom([{ zoom: 6, markers: 3, hidden: 0, valid: true }, { zoom: 6.25, markers: 3, hidden: 0, valid: true }]), 1);
  // 圆盘露出窗边的档不算
  assert.equal(pickInsetZoom([{ zoom: 7, markers: 4, hidden: 0, valid: false }, { zoom: 6.5, markers: 4, hidden: 2, valid: true }]), 1);
  // 哪档都放不下：挑缩得最小的；没有候选：-1
  assert.equal(pickInsetZoom([{ zoom: 7, markers: 4, hidden: 0, valid: false }, { zoom: 6.5, markers: 4, hidden: 0, valid: false }]), 1);
  assert.equal(pickInsetZoom([]), -1);
});

test("名字上下都摆不下时摆到圆盘旁边（离窗边远的那侧先试）；不给 sideGap 就不试", () => {
  const disc = (x: number, y: number): PixelBox => ({ x: x - 13, y: y - 13, w: 26, h: 26 });
  // 上面一条胶囊、下面一枚圆盘，把上下都堵死；左右空着
  const walls: PixelBox[] = [{ x: 30, y: 40, w: 100, h: 24 }, { x: 30, y: 104, w: 100, h: 26 }, disc(60, 84)];
  const item: LabelItem = { key: "dg", x: 60, y: 84, w: 58, h: 20, tightW: 52, gap: 15, sideGap: 16 };
  const [side] = placeInsetLabels([item], walls, { width: 176, height: 186 });
  assert.equal(side.hidden, undefined);
  assert.equal(side.side, "right", "圆盘在窗左半边：先试右边");
  assert.equal(side.box.x, 60 + 16);
  assert.equal(side.dx, 16, "dx 是名字左边缘离锚点多远");
  assert.ok(Math.abs(side.box.y + side.box.h / 2 - 84) < 1e-9, "竖直居中在锚点上");
  for (const wall of walls) assert.ok(!overlap(side.box, wall));
  // 靠右的圆盘先试左边
  const right = placeInsetLabels([{ ...item, x: 150 }], [{ x: 110, y: 40, w: 60, h: 24 }, { x: 110, y: 104, w: 60, h: 26 }, disc(150, 84)], { width: 176, height: 186 });
  assert.equal(right[0].side, "left");
  // 不给 sideGap：还是藏
  const { sideGap: _unused, ...plain } = item;
  assert.equal(placeInsetLabels([plain], walls, { width: 176, height: 186 })[0].hidden, true);
});

test("小窗标准尺寸哪个角都压到 marker 时，找放得下的最大尺寸，不直接缩到最小", () => {
  // 手机主图：右下角左边有悉尼的名字（x 102..159），标准尺寸（156 宽）挪开 + / − 后会压上它
  const container = { width: 338, height: 298 };
  const occupancy = {
    boxes: [
      { x: 36, y: 131, w: 26, h: 26 }, { x: 16, y: 159, w: 57, h: 20 }, // 新加坡
      { x: 274, y: 70, w: 26, h: 26 }, { x: 252, y: 98, w: 69, h: 20 }, // 美国
      { x: 118, y: 196, w: 26, h: 26 }, { x: 102, y: 224, w: 57, h: 20 }, // 悉尼
      { x: 39, y: 90, w: 73, h: 22 }, { x: 23, y: 67, w: 96, h: 20 }, // 港粤的组
    ],
    points: [],
    reserved: [{ x: 298, y: 226, w: 36, h: 68 }, { x: 258, y: 4, w: 76, h: 29 }],
  };
  const sizes = insetSizes(container, false);
  const [inset] = placeInsets(container, occupancy, 1, false);
  assert.equal(inset.shrunk, true);
  assert.ok(inset.box.w * inset.box.h > sizes.min.w * sizes.min.h, `比最小尺寸大：${JSON.stringify(inset.box)}`);
  assert.ok(inset.box.w <= sizes.full.w && inset.box.h <= sizes.full.h);
  for (const box of [...occupancy.boxes, ...occupancy.reserved]) assert.ok(!overlap(inset.box, box), `压着 ${JSON.stringify(box)}`);
});
