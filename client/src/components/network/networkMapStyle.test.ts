import assert from "node:assert/strict";
import test from "node:test";

import {
  NETWORK_MAP_LAYERS,
  baseLayerPaintPatch,
  buildNetworkMapStyle,
  cometPaint,
  cometTailGradient,
  dimOpacityExpression,
  lighten,
  linkGradient,
  rasterSourceIds,
  rasterTonePaint,
  rasterVisibility,
  withAlpha,
} from "./networkMapStyle";

const colors = { healthy: "#0b74d1", warn: "#d97706", down: "#dc2626", standby: "#737373", casing: "#ffffff" };
const base = { water: "#e3e9ef", land: "#fbfbf9", landShadow: "rgba(15,23,42,0.08)", border: "rgba(30,41,59,0.18)" };

test("一份样式装下三种底图：所有栅格源都在，只有激活的那个可见", () => {
  const style = buildNetworkMapStyle("sat", "dark", "/globe/x.geojson", colors, base);
  const ids = rasterSourceIds();
  assert.deepEqual(ids, ["amap-road", "amap-sat", "amap-sat-labels"]);
  for (const id of ids) assert.ok(style.sources[id], `源 ${id} 在样式里`);
  const visibility = Object.fromEntries(style.layers.filter((layer: any) => layer.type === "raster").map((layer: any) => [layer.id, layer.layout.visibility]));
  assert.deepEqual(visibility, { "amap-road": "none", "amap-sat": "visible", "amap-sat-labels": "visible" });
  assert.deepEqual(rasterVisibility("vector"), { "amap-road": "none", "amap-sat": "none", "amap-sat-labels": "none" });
});

test("高德瓦片压低饱和度；深色皮肤下标准图整体压暗", () => {
  assert.equal(rasterTonePaint("amap-road", "light")["raster-saturation"], -0.35);
  assert.ok(rasterTonePaint("amap-road", "light")["raster-contrast"] < 0);
  assert.ok(rasterTonePaint("amap-road", "dark")["raster-brightness-max"] < 0.7, "深色主题下白底瓦片压暗");
  assert.ok(rasterTonePaint("amap-road", "light")["raster-brightness-max"] > 0.9);
  const style = buildNetworkMapStyle("light", "dark", "/globe/x.geojson", colors, base);
  const road = style.layers.find((layer: any) => layer.id === "amap-road") as any;
  assert.equal(road.paint["raster-fade-duration"], 0);
  assert.equal(road.paint["raster-brightness-max"], rasterTonePaint("amap-road", "dark")["raster-brightness-max"]);
});

test("图层顺序：底色 → 瓦片 → 陆地影子 → 陆地 → 国界 → 流向 → 命中层 → 细边 → 线；没有经纬网", () => {
  const style = buildNetworkMapStyle("vector", "light", "/globe/x.geojson", colors, base);
  const order = style.layers.map((layer: any) => layer.id);
  const index = (id: string) => order.indexOf(id);
  assert.ok(index(NETWORK_MAP_LAYERS.background) < index("amap-road"));
  assert.ok(index("amap-sat-labels") < index(NETWORK_MAP_LAYERS.landShadow));
  assert.ok(index(NETWORK_MAP_LAYERS.landShadow) < index(NETWORK_MAP_LAYERS.land));
  assert.ok(index(NETWORK_MAP_LAYERS.borders) < index(NETWORK_MAP_LAYERS.flow));
  assert.ok(index(NETWORK_MAP_LAYERS.flow) < index(NETWORK_MAP_LAYERS.linkHit));
  assert.ok(index(NETWORK_MAP_LAYERS.linkCasing) < index(NETWORK_MAP_LAYERS.linkDashed));
  assert.ok(index(NETWORK_MAP_LAYERS.linkDashed) < index(NETWORK_MAP_LAYERS.linkSolid));
  assert.ok(!order.some((id: string) => /graticule/.test(id)), "不画经纬网");
  assert.equal((style.layers[0] as any).paint["background-color"], base.water);
  const land = style.layers.find((layer: any) => layer.id === NETWORK_MAP_LAYERS.land) as any;
  assert.equal(land.paint["fill-color"], base.land);
  const borders = style.layers.find((layer: any) => layer.id === NETWORK_MAP_LAYERS.borders) as any;
  assert.equal(borders.paint["line-width"], 0.5, "国界 0.5px");
  const hit = style.layers.find((layer: any) => layer.id === NETWORK_MAP_LAYERS.linkHit) as any;
  assert.equal(hit.paint["line-opacity"], 0, "命中层看不见");
  assert.ok(hit.paint["line-width"] >= 12, "命中层够宽，手指点得中");
});

test("线要素的 promoteId 是 fid、开了 lineMetrics；聚焦用 feature-state 把无关的线压到 12%", () => {
  const style = buildNetworkMapStyle("light", "light", "/globe/x.geojson", colors, base);
  assert.equal((style.sources["nm-links"] as any).promoteId, "fid");
  assert.equal((style.sources["nm-links"] as any).lineMetrics, true);
  assert.deepEqual(dimOpacityExpression(1), ["*", 1, ["case", ["boolean", ["feature-state", "dim"], false], 0.12, 1]]);
});

test("正常线路：入口强调色 → 出口浅一档的渐变；不正常的是虚线", () => {
  assert.equal(lighten("#000000", 0.5), "#808080");
  assert.equal(lighten("rgb(255, 0, 0)", 0.5), "#ff8080");
  assert.equal(lighten("oklch(0.6 0.1 200)", 0.5), "oklch(0.6 0.1 200)", "认不出的写法原样返回");
  assert.deepEqual(linkGradient(colors), ["interpolate", ["linear"], ["line-progress"], 0, "#0b74d1", 1, lighten("#0b74d1", 0.45)]);
  const style = buildNetworkMapStyle("vector", "light", "/globe/x.geojson", colors, base);
  const solid = style.layers.find((layer: any) => layer.id === NETWORK_MAP_LAYERS.linkSolid) as any;
  assert.deepEqual(solid.paint["line-gradient"], linkGradient(colors));
  const dashed = style.layers.find((layer: any) => layer.id === NETWORK_MAP_LAYERS.linkDashed) as any;
  assert.ok(Array.isArray(dashed.paint["line-dasharray"]));
  assert.deepEqual(dashed.filter, ["!=", ["get", "health"], "healthy"]);
});

test("换底图的补丁：简洁底图画陆地和国界，高德不画；栅格的压色跟着皮肤", () => {
  assert.equal(baseLayerPaintPatch("sat", "dark").borderWidth, 0);
  assert.equal(baseLayerPaintPatch("light", "light").landOpacity, 0);
  assert.equal(baseLayerPaintPatch("vector", "dark").landOpacity, 1);
  assert.equal(baseLayerPaintPatch("vector", "dark").raster["amap-road"], "none");
  assert.deepEqual(baseLayerPaintPatch("light", "dark").rasterPaint["amap-road"], rasterTonePaint("amap-road", "dark"));
});

test("箭头和彗星压在线的上面：尾巴的渐变从透明渐到半透明的正常色，源开了 lineMetrics", () => {
  const style = buildNetworkMapStyle("vector", "dark", "/globe/x.geojson", colors, base);
  const order = style.layers.map((layer: any) => layer.id);
  const index = (id: string) => order.indexOf(id);
  assert.ok(index(NETWORK_MAP_LAYERS.linkSolid) < index(NETWORK_MAP_LAYERS.tip));
  assert.ok(index(NETWORK_MAP_LAYERS.tip) < index(NETWORK_MAP_LAYERS.cometTail));
  assert.ok(index(NETWORK_MAP_LAYERS.cometTail) < index(NETWORK_MAP_LAYERS.cometGlow));
  assert.ok(index(NETWORK_MAP_LAYERS.cometGlow) < index(NETWORK_MAP_LAYERS.cometHead));
  assert.equal((style.sources["nm-comets"] as any).lineMetrics, true);
  const tail = style.layers.find((layer: any) => layer.id === NETWORK_MAP_LAYERS.cometTail) as any;
  assert.deepEqual(tail.paint["line-gradient"], cometTailGradient(colors));
  assert.deepEqual(cometTailGradient(colors), ["interpolate", ["linear"], ["line-progress"], 0, withAlpha("#0b74d1", 0), 0.65, withAlpha("#0b74d1", 0.35), 1, withAlpha("#0b74d1", 0.8)]);
  assert.equal(withAlpha("#0b74d1", 0.5), "rgba(11,116,209,0.5)");
  assert.equal(cometPaint(colors).head["circle-stroke-color"], "#0b74d1");
  const head = style.layers.find((layer: any) => layer.id === NETWORK_MAP_LAYERS.cometHead) as any;
  assert.ok(head.paint["circle-radius"] <= 2.5, "彗星头小一号");
});
