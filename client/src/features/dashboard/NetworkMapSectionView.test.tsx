import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

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
  assert.match(html, /正常 1/);
  assert.match(html, /停用 1/);
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
