import assert from "node:assert/strict";
import test from "node:test";

import { buildNetworkMapModel } from "./networkMapModel";
import type { PixelBox } from "@shared/networkMapGeometry";

import { MINI_CAP_MIN_ARC_PX, MINI_FIT_MAX_ZOOM, MINI_GROUP_RADIUS_PX, cornerBox, detectWebGL, groupCoverageBox, groupTipText, hostTipText, insetLeader, insetSizes, linkTipText, locatedHostCount, matchInsetGroup, miniFitPoints, miniMinZoom, pickInsetGroups, placeInsets, placeLabelBoxes, scoreQuadrants, shouldAbsorbIntoGroup, shouldRefit, shouldRenderRealMap, unlocatedHostCount, type LabelItem } from "./networkMapMini";

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

test("小图的常量：最多放到 9 级，90px 以上才挂胶囊；用户最多能缩到框好的再小一级", () => {
  assert.equal(MINI_FIT_MAX_ZOOM, 9);
  assert.equal(MINI_CAP_MIN_ARC_PX, 90);
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
  // pill 有两面旗、数字 4：半宽 30 上下；紧挨着右边 36px 的那台并进来，上下 40px 的不并
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
