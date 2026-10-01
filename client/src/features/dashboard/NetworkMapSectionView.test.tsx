import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { NetworkMapMiniChrome } from "./NetworkMapMiniChrome";
import { NetworkMapSectionView, buildNetworkMapModel } from "./NetworkMapSection";

const now = 1_700_000_000_000;
const host = (id: number, name: string, geo?: [number, number]) => ({
  id, name, isOnline: true, lastHeartbeat: now - 1000,
  ...(geo ? { geoLatitudeMicro: Math.round(geo[0] * 1e6), geoLongitudeMicro: Math.round(geo[1] * 1e6) } : {}),
});

test("卡片：没有画布（node 里没有 WebGL）时照样画出标题、入口、图例和 SVG 示意图", () => {
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
  assert.match(html, /打开地图/);
  // 图例是四类线（主线路 / 备用 / 降级 / 中断），只列有的；数字单独一个等宽、正文色的 span
  assert.match(html, /主线路 <span[^>]*tabular-nums[^>]*>1<\/span>/);
  assert.match(html, /备用 <span[^>]*>1<\/span>/);
  assert.doesNotMatch(html, /中断 <span/);
  assert.match(html, /<svg/, "兜底是 SVG 示意图");
  assert.match(html, /aria-label="网络地图：3 台主机，2 条线路"/);
  assert.doesNotMatch(html, /nm-mini/, "没要真地图就不出现小图的壳");
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
  // 小图上点哪儿都不跳整页：这里只有 type=button，没有 href，也没有 /map
  assert.doesNotMatch(moved, /href=/);
  assert.doesNotMatch(moved, /\/map/);
  assert.equal((moved.match(/<button/g) || []).length, 3);
});

test("卡片：整页的入口只有标题旁的「打开地图」", () => {
  const model = buildNetworkMapModel({ now, hosts: [host(1, "HK", [22.32, 114.17]), host(2, "JP", [35.68, 139.65])], tunnels: [{ id: 1, name: "live", mode: "forwardx", isEnabled: true, entryHostId: 1, exitHostId: 2 }] });
  const html = renderToStaticMarkup(<NetworkMapSectionView model={model} onOpen={() => {}} realMap={false} />);
  assert.equal((html.match(/打开地图/g) || []).length, 1);
  assert.doesNotMatch(html, /href="\/map/);
});
