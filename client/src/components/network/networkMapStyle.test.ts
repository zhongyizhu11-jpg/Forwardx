import assert from "node:assert/strict";
import test from "node:test";

import {
  NETWORK_MAP_LAYERS,
  COARSE_COAST_ZOOM,
  TEXTURE_FADE_ZOOM,
  TEXTURE_LAYER_IDS,
  TEXTURE_LAYER_MAX_ZOOM,
  baseColorsFor,
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
  assert.deepEqual(rasterTonePaint(TEXTURE_LAYER_IDS.night)["raster-opacity"], zoomFade(0.9, 0), "放大到地球图糊掉之前淡没");
  assert.deepEqual(rasterTonePaint(TEXTURE_LAYER_IDS.day)["raster-opacity"], zoomFade(1, 0));
  assert.deepEqual(zoomFade(1, 0), ["interpolate", ["linear"], ["zoom"], 4.5, 1, 5.5, 0]);
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

/** 按 zoom 插值的表达式在某一级的值（只认 linear interpolate） */
function at(expression: unknown, zoom: number): number {
  if (typeof expression === "number") return expression;
  const stops = (expression as unknown[]).slice(3) as number[];
  if (zoom <= stops[0]) return stops[1];
  for (let i = 2; i < stops.length; i += 2) {
    if (zoom <= stops[i]) return stops[i - 1] + ((stops[i + 1] - stops[i - 1]) * (zoom - stops[i - 2])) / (stops[i] - stops[i - 2]);
  }
  return stops[stops.length - 1];
}

test("换底图的补丁：暗黑网格画陆地和经纬网；地球图远看只有夜光图一道淡国界，地球图淡出时陆地和国界接上来；高德都不画", () => {
  assert.equal(baseLayerPaintPatch("grid").graticule, "visible");
  assert.equal(at(baseLayerPaintPatch("grid").landOpacity, 3), 1);
  assert.equal(at(baseLayerPaintPatch("grid").borderOpacity, 3), 1);
  assert.equal(baseLayerPaintPatch("night").graticule, "none");
  assert.equal(at(baseLayerPaintPatch("night").landOpacity, 3), 0, "远看是夜光图，不画陆地");
  assert.equal(at(baseLayerPaintPatch("night").landOpacity, TEXTURE_FADE_ZOOM[1]), 1, "地球图淡没时陆地接满");
  assert.equal(at(baseLayerPaintPatch("night").borderOpacity, 3), 0.5);
  assert.equal(at(baseLayerPaintPatch("sat").borderOpacity, 3), 0);
  assert.equal(at(baseLayerPaintPatch("sat").borderOpacity, 5.5), 1);
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

test("地球图 5.5 级以上不画（图层 maxzoom，连瓦片都不要），4.5 → 5.5 级淡出、矢量陆地同时接上", () => {
  assert.deepEqual(TEXTURE_FADE_ZOOM, [4.5, 5.5]);
  const style = buildNetworkMapStyle("night", "/globe/x.geojson", colors, base);
  for (const id of [TEXTURE_LAYER_IDS.night, TEXTURE_LAYER_IDS.day]) {
    const layer = style.layers.find((item: any) => item.id === id) as any;
    assert.equal(layer.maxzoom, TEXTURE_LAYER_MAX_ZOOM);
    assert.equal(at(layer.paint["raster-opacity"], TEXTURE_FADE_ZOOM[1]), 0);
  }
  const road = style.layers.find((item: any) => item.id === "amap-road") as any;
  assert.equal(road.maxzoom, undefined, "高德街道图放大照样要");
});

test("110m 国界放大后对不上真实海岸线（珠江口的三角缺口）：陆地和国界 5.5 → 7 级淡下去，所有底图都一样", () => {
  assert.deepEqual(COARSE_COAST_ZOOM, [5.5, 7]);
  for (const id of ["night", "sat", "grid"] as const) {
    const patch = baseLayerPaintPatch(id);
    assert.equal(at(patch.landOpacity, COARSE_COAST_ZOOM[0]), 1, `${id}：5.5 级还是满的`);
    assert.ok(at(patch.landOpacity, COARSE_COAST_ZOOM[1]) <= 0.2, `${id}：7 级陆地淡下去`);
    assert.ok(at(patch.borderOpacity, COARSE_COAST_ZOOM[1]) <= 0.2, `${id}：7 级国界淡下去`);
  }
});

test("首页小窗只画矢量：不画任何栅格（地球图、高德都不画）、不画经纬网，颜色是夜光那套", () => {
  for (const id of ["night", "sat", "grid", "amap"] as const) {
    const patch = baseLayerPaintPatch(id, { vectorOnly: true });
    assert.ok(Object.values(patch.raster).every((value) => value === "none"), `${id}：没有栅格`);
    assert.equal(patch.graticule, "none");
    assert.equal(at(patch.landOpacity, 3), 1, `${id}：缩得很小时陆地也在（小窗没有地球图可退）`);
    assert.ok(at(patch.landOpacity, 6) <= 0.2 && at(patch.borderOpacity, 6) <= 0.1, `${id}：小窗常在 6 级以上，粗海岸线淡到看不出`);
    const style = buildNetworkMapStyle(id, "/globe/x.geojson", colors, { ...base, nightWater: "#020414", nightLand: "#070c1f" }, { vectorOnly: true });
    assert.equal((style.layers[0] as any).paint["background-color"], "#020414");
    const land = style.layers.find((layer: any) => layer.id === NETWORK_MAP_LAYERS.land) as any;
    assert.equal(land.paint["fill-color"], "#070c1f");
    assert.ok(style.layers.filter((layer: any) => layer.type === "raster").every((layer: any) => layer.layout.visibility === "none"));
  }
  // 整页：地球图用夜光那套，暗黑网格、高德用自己的
  const withNight = { ...base, nightWater: "#020414", nightLand: "#070c1f" };
  assert.equal(baseColorsFor("night", withNight).water, "#020414");
  assert.equal(baseColorsFor("sat", withNight).land, "#070c1f");
  assert.equal(baseColorsFor("grid", withNight).water, base.water);
  assert.equal(baseColorsFor("grid", withNight, { vectorOnly: true }).water, "#020414");
  assert.equal(baseColorsFor("night", base).water, base.water, "没给夜光那套就用原来的");
});

test("所有按级别插值的透明度：级别严格递增（MapLibre 不认重复的级别，整层都不画）", () => {
  const check = (expression: unknown, label: string) => {
    if (!Array.isArray(expression) || expression[0] !== "interpolate") return;
    const inputs = (expression.slice(3) as number[]).filter((_, index) => index % 2 === 0);
    for (let i = 1; i < inputs.length; i += 1) assert.ok(inputs[i] > inputs[i - 1], `${label}：${JSON.stringify(expression)}`);
  };
  for (const id of ["night", "sat", "grid", "amap"] as const) {
    for (const vectorOnly of [false, true]) {
      const patch = baseLayerPaintPatch(id, { vectorOnly });
      check(patch.landOpacity, `${id} 陆地`);
      check(patch.borderOpacity, `${id} 国界`);
      for (const paint of Object.values(patch.rasterPaint)) check((paint as Record<string, unknown>)["raster-opacity"], `${id} 栅格`);
    }
  }
});
