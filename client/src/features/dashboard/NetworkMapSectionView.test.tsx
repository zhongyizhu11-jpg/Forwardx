import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { NetworkMapMiniChrome } from "./NetworkMapMiniChrome";
import { NetworkMapSectionView, buildNetworkMapModel, legendItems } from "./NetworkMapSection";

const now = 1_700_000_000_000;
const host = (id: number, name: string, geo?: [number, number]) => ({
  id, name, isOnline: true, lastHeartbeat: now - 1000,
  ...(geo ? { geoLatitudeMicro: Math.round(geo[0] * 1e6), geoLongitudeMicro: Math.round(geo[1] * 1e6) } : {}),
});

test("卡片：没有画布（node 里没有 WebGL）时照样画出标题、图例和 SVG 示意图，没有任何去整页的入口", () => {
  const model = buildNetworkMapModel({
    now,
    hosts: [host(1, "HK", [22.32, 114.17]), host(2, "JP", [35.68, 139.65]), host(3, "无坐标")],
    tunnels: [
      { id: 1, name: "live", mode: "forwardx", isEnabled: true, entryHostId: 1, exitHostId: 2 },
      { id: 2, name: "paused", mode: "forwardx", isEnabled: false, entryHostId: 1, exitHostId: 3 },
    ],
  });
  const html = renderToStaticMarkup(<NetworkMapSectionView model={model} onOpen={() => {}} realMap={false} />);
  assert.match(html, /aria-label="网络地图"/);
  assert.match(html, />网络地图</);
  // 整页地图已经去掉：标题旁不再有「打开地图」，也没有任何指向 /map 的东西
  assert.doesNotMatch(html, /打开地图/);
  assert.doesNotMatch(html, /\/map/);
  // 图例：主线路 / 降级 / 中断一直列（0 也写），备用有才列；数字单独一个等宽、正文色的 span
  assert.match(html, /主线路 <span[^>]*tabular-nums[^>]*>1<\/span>/);
  assert.match(html, /降级 <span[^>]*>0<\/span>/);
  assert.match(html, /中断 <span[^>]*>0<\/span>/);
  assert.match(html, /备用 <span[^>]*>1<\/span>/);
  assert.match(html, /<svg/, "兜底是 SVG 示意图");
  assert.match(html, /aria-label="网络地图：3 台主机，2 条线路"/);
  assert.doesNotMatch(html, /nm-mini/, "没要真地图就不出现小图的壳");
});

test("图例：备用为 0 时不列，另外三类按 主线路 → 降级 → 中断 排", () => {
  assert.deepEqual(legendItems({ main: 2, backup: 0, degraded: 1, down: 0 }).map((item) => `${item.label} ${item.count}`), ["主线路 2", "降级 1", "中断 0"]);
  assert.deepEqual(legendItems({ main: 0, backup: 3, degraded: 0, down: 1 }).map((item) => item.label), ["主线路", "降级", "中断", "备用"]);
});

test("卡片：一条线也没有时写一句怎么连，经过看不到的主机的隧道说明没画出来", () => {
  const empty = buildNetworkMapModel({ now, hosts: [host(1, "a")], tunnels: [] });
  assert.match(renderToStaticMarkup(<NetworkMapSectionView model={empty} onOpen={() => {}} realMap={false} />), /还没有线路/);
  const hidden = buildNetworkMapModel({
    now,
    hosts: [host(1, "a")],
    tunnels: [{ id: 5, name: "shared", mode: "tls", isEnabled: true, entryHostId: 1, exitHostId: null, hopHostIds: [1], availability: { status: "available", available: true, source: "hosts", message: "ok" } }],
  });
  assert.match(renderToStaticMarkup(<NetworkMapSectionView model={hidden} onOpen={() => {}} realMap={false} />), /1 条经过你看不到的主机，没有画出来/);
});

test("小图上漂浮的东西：+ / − 常在，「回到全览」只在用户动过图之后出现，提示只在点过之后出现；没有一个是链接", () => {
  const still = renderToStaticMarkup(<NetworkMapMiniChrome userMoved={false} tip={null} unlocated={0} onZoom={() => {}} onReset={() => {}} />);
  assert.match(still, /aria-label="放大"/);
  assert.match(still, /aria-label="缩小"/);
  assert.doesNotMatch(still, /回到全览/, "没动过图不出现");
  assert.doesNotMatch(still, /nm-mini-tip/);
  assert.doesNotMatch(still, /未定位/);
  const moved = renderToStaticMarkup(<NetworkMapMiniChrome userMoved tip="HK entry 01 · 香港 · 在线" unlocated={2} onZoom={() => {}} onReset={() => {}} />);
  assert.match(moved, /<button type="button" class="nm-mini-reset">回到全览<\/button>/);
  assert.match(moved, /class="nm-mini-tip"[^>]*>HK entry 01 · 香港 · 在线</);
  assert.match(moved, /2 台未定位/);
  // 小图上点哪儿都不跳：这里只有 type=button，没有 href
  assert.doesNotMatch(moved, /href=/);
  assert.equal((moved.match(/<button/g) || []).length, 3);
});
