import assert from "node:assert/strict";
import test from "node:test";

import {
  NETWORK_MAP_LAYERS,
  TEXTURE_LAYER_IDS,
  baseLayerPaintPatch,
  buildNetworkMapStyle,
  dimOpacityExpression,
  graticuleGeoJson,
  kindColorExpression,
  lighten,
  linkGradient,
  rasterSourceIds,
  rasterTonePaint,
  rasterVisibility,
  withAlpha,
  zoomFade,
} from "./networkMapStyle";

const colors = { main: "#3b82f6", backup: "#cbd5e1", degraded: "#f59e0b", down: "#ef4444", flow: "#a855f7", particle: "#e0f2fe" };
const base = { water: "#050b16", land: "#0c1625", border: "rgba(56,189,248,0.22)", graticule: "rgba(34,211,238,0.08)" };

test("一份样式装下四种底图：两张地球图走自定义协议、高德走瓦片，只有激活的那个可见", () => {
  const style = buildNetworkMapStyle("night", "/globe/x.geojson", colors, base);
  assert.deepEqual(rasterSourceIds(), ["earth-night", "earth-day", "amap-road"]);
  assert.deepEqual(style.sources["earth-night"].tiles, ["fxearth://night/{z}/{x}/{y}"]);
  assert.equal(style.sources["earth-night"].maxzoom, 4, "原图 4096 宽，第 4 级以上 MapLibre 自己放大");
  assert.deepEqual(style.sources["earth-day"].tiles, ["fxearth://day/{z}/{x}/{y}"]);
  const visibility = Object.fromEntries(style.layers.filter((layer: any) => layer.type === "raster").map((layer: any) => [layer.id, layer.layout.visibility]));
  assert.deepEqual(visibility, { "earth-night": "visible", "earth-day": "none", "amap-road": "none" });
  assert.deepEqual(rasterVisibility("sat"), { "earth-night": "none", "earth-day": "visible", "amap-road": "none" });
  assert.deepEqual(rasterVisibility("grid"), { "earth-night": "none", "earth-day": "none", "amap-road": "none" });
  assert.deepEqual(rasterVisibility("amap"), { "earth-night": "none", "earth-day": "none", "amap-road": "visible" });
});

test("压色：卫星图压暗；高德反相成深色；夜光图透出一点底下的海军蓝", () => {
  assert.ok((rasterTonePaint(TEXTURE_LAYER_IDS.day)["raster-brightness-max"] as number) < 0.6);
  const amap = rasterTonePaint("amap-road") as Record<string, number>;
  assert.ok(amap["raster-brightness-min"] > amap["raster-brightness-max"], "min > max 就是反相");
  assert.equal(amap["raster-hue-rotate"], 180);
  assert.deepEqual(rasterTonePaint(TEXTURE_LAYER_IDS.night)["raster-opacity"], zoomFade(0.9, 0.3), "放大到地球图糊掉时淡掉");
  assert.deepEqual(zoomFade(1, 0), ["interpolate", ["linear"], ["zoom"], 5, 1, 8, 0]);
  const style = buildNetworkMapStyle("amap", "/globe/x.geojson", colors, base);
  const road = style.layers.find((layer: any) => layer.id === "amap-road") as any;
  assert.equal(road.paint["raster-fade-duration"], 0);
});

test("图层顺序：底色 → 栅格 → 陆地 → 经纬网 → 国界 → 流向 → 命中层 → 光 → 主线路 → 虚线（出问题的不被盖住）→ 中转点 → 光点", () => {
  const style = buildNetworkMapStyle("grid", "/globe/x.geojson", colors, base);
  const order = style.layers.map((layer: any) => layer.id);
  const index = (id: string) => order.indexOf(id);
  const sequence = [NETWORK_MAP_LAYERS.background, "earth-night", "amap-road", NETWORK_MAP_LAYERS.land, NETWORK_MAP_LAYERS.graticule, NETWORK_MAP_LAYERS.borders, NETWORK_MAP_LAYERS.flow, NETWORK_MAP_LAYERS.linkHit, NETWORK_MAP_LAYERS.linkGlow, NETWORK_MAP_LAYERS.linkMain, NETWORK_MAP_LAYERS.linkDashed, NETWORK_MAP_LAYERS.waypoints, NETWORK_MAP_LAYERS.particleGlow, NETWORK_MAP_LAYERS.particleCore];
  for (let i = 1; i < sequence.length; i += 1) assert.ok(index(sequence[i - 1]) < index(sequence[i]), `${sequence[i - 1]} 在 ${sequence[i]} 下面`);
  const hit = style.layers.find((layer: any) => layer.id === NETWORK_MAP_LAYERS.linkHit) as any;
  assert.equal(hit.paint["line-opacity"], 0, "命中层看不见");
  assert.ok(hit.paint["line-width"] >= 12, "命中层够宽，手指点得中");
  assert.equal((style.layers[0] as any).paint["background-color"], base.water);
});

test("霓虹线：光宽而模糊；主线路实线渐亮，其余三类虚线；颜色按 kind 取", () => {
  const style = buildNetworkMapStyle("night", "/globe/x.geojson", colors, base);
  const glow = style.layers.find((layer: any) => layer.id === NETWORK_MAP_LAYERS.linkGlow) as any;
  assert.ok(glow.paint["line-blur"] >= 4);
  assert.deepEqual(glow.paint["line-color"], kindColorExpression(colors));
  assert.deepEqual(kindColorExpression(colors), ["match", ["get", "kind"], "main", "#3b82f6", "degraded", "#f59e0b", "down", "#ef4444", "#cbd5e1"]);
  const main = style.layers.find((layer: any) => layer.id === NETWORK_MAP_LAYERS.linkMain) as any;
  assert.deepEqual(main.filter, ["==", ["get", "kind"], "main"]);
  assert.deepEqual(main.paint["line-gradient"], linkGradient(colors));
  assert.deepEqual(linkGradient(colors), ["interpolate", ["linear"], ["line-progress"], 0, "#3b82f6", 1, lighten("#3b82f6", 0.4)]);
  const dashed = style.layers.find((layer: any) => layer.id === NETWORK_MAP_LAYERS.linkDashed) as any;
  assert.deepEqual(dashed.filter, ["!=", ["get", "kind"], "main"]);
  assert.ok(Array.isArray(dashed.paint["line-dasharray"]));
  const flow = style.layers.find((layer: any) => layer.id === NETWORK_MAP_LAYERS.flow) as any;
  assert.equal(flow.paint["line-color"], colors.flow, "落地流向是落地节点的紫");
});

test("线要素的 promoteId 是 fid、开了 lineMetrics；筛掉的不画、聚焦时无关的压到 12%", () => {
  const style = buildNetworkMapStyle("night", "/globe/x.geojson", colors, base);
  assert.equal((style.sources["nm-links"] as any).promoteId, "fid");
  assert.equal((style.sources["nm-links"] as any).lineMetrics, true);
  assert.deepEqual(dimOpacityExpression(1), ["*", 1, ["case", ["boolean", ["feature-state", "hide"], false], 0, ["boolean", ["feature-state", "dim"], false], 0.12, 1]]);
});

test("换底图的补丁：暗黑网格画陆地和经纬网；地球图远看只有夜光图一道淡国界，放大时陆地和国界接上来；高德都不画", () => {
  assert.deepEqual([baseLayerPaintPatch("grid").landOpacity, baseLayerPaintPatch("grid").graticule, baseLayerPaintPatch("grid").borderOpacity], [1, "visible", 1]);
  assert.deepEqual([baseLayerPaintPatch("night").landOpacity, baseLayerPaintPatch("night").graticule], [zoomFade(0, 1), "none"]);
  assert.deepEqual(baseLayerPaintPatch("night").borderOpacity, zoomFade(0.5, 1));
  assert.deepEqual(baseLayerPaintPatch("sat").borderOpacity, zoomFade(0, 1));
  assert.equal(baseLayerPaintPatch("amap").borderOpacity, 0);
  assert.equal(baseLayerPaintPatch("amap").borderWidth, 0);
  assert.equal(baseLayerPaintPatch("sat").raster["earth-day"], "visible");
});

test("经纬网每 15° 一条；颜色工具", () => {
  const grid = graticuleGeoJson();
  assert.equal(grid.features[0].geometry.coordinates.length, 25 + 11);
  assert.equal(withAlpha("#0b74d1", 0.5), "rgba(11,116,209,0.5)");
  assert.equal(lighten("#000000", 0.5), "#808080");
  assert.equal(lighten("oklch(0.6 0.1 200)", 0.5), "oklch(0.6 0.1 200)", "认不出的写法原样返回");
});
