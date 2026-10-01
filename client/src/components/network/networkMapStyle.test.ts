import assert from "node:assert/strict";
import test from "node:test";

import {
  BORDER_OPACITY,
  COARSE_COAST_ZOOM,
  LAND_OPACITY,
  NETWORK_MAP_LAYERS,
  NETWORK_MAP_SOURCES,
  TEXTURE_FADE_ZOOM,
  TEXTURE_LAYER_MAX_ZOOM,
  buildNetworkMapStyle,
  kindColorExpression,
  lighten,
  linkGradient,
  nightTonePaint,
  zoomFade,
} from "./networkMapStyle";

const colors = { main: "#3b82f6", backup: "#cbd5e1", degraded: "#f59e0b", down: "#ef4444", particle: "#e0f2fe" };
const base = { water: "#000213", land: "#060a1d", border: "rgba(56,189,248,0.22)" };
const style = buildNetworkMapStyle("/globe/x.geojson", colors, base);
const layer = (id: string) => style.layers.find((item: any) => item.id === id) as any;

test("底图只有夜光地球图一张：走自定义协议、最多切到第 4 级；没有别的栅格", () => {
  assert.deepEqual(style.sources[NETWORK_MAP_SOURCES.night].tiles, ["fxearth://night/{z}/{x}/{y}"]);
  assert.equal(style.sources[NETWORK_MAP_SOURCES.night].maxzoom, 4, "第 4 级以上 MapLibre 自己放大（4 级的调色和 3 级不同，所以切到 4 级）");
  assert.deepEqual(style.layers.filter((item: any) => item.type === "raster").map((item: any) => item.id), [NETWORK_MAP_LAYERS.night]);
  assert.equal(layer(NETWORK_MAP_LAYERS.night).paint["raster-fade-duration"], 0);
  assert.deepEqual(nightTonePaint()["raster-opacity"], zoomFade(0.9, 0), "放大到地球图糊掉之前淡没");
  assert.deepEqual(zoomFade(1, 0), ["interpolate", ["linear"], ["zoom"], 4.5, 1, 5.5, 0]);
  assert.equal((style.layers[0] as any).paint["background-color"], base.water);
  assert.equal(layer(NETWORK_MAP_LAYERS.land).paint["fill-color"], base.land);
});

test("图层顺序：底色 → 地球图 → 陆地 → 国界 → 命中层 → 光 → 主线路 → 虚线（出问题的不被盖住）→ 箭头 → 中转点 → 光点", () => {
  const order = style.layers.map((item: any) => item.id);
  const sequence = [NETWORK_MAP_LAYERS.background, NETWORK_MAP_LAYERS.night, NETWORK_MAP_LAYERS.land, NETWORK_MAP_LAYERS.borders, NETWORK_MAP_LAYERS.linkHit, NETWORK_MAP_LAYERS.linkGlow, NETWORK_MAP_LAYERS.linkMain, NETWORK_MAP_LAYERS.linkDashed, NETWORK_MAP_LAYERS.arrows, NETWORK_MAP_LAYERS.waypoints, NETWORK_MAP_LAYERS.particleGlow, NETWORK_MAP_LAYERS.particleCore];
  assert.deepEqual(order, sequence);
  const hit = layer(NETWORK_MAP_LAYERS.linkHit);
  assert.equal(hit.paint["line-opacity"], 0, "命中层看不见");
  assert.ok(hit.paint["line-width"] >= 12, "命中层够宽，手指点得中");
});

test("霓虹线：光宽而模糊；主线路实线渐亮，其余三类虚线；颜色按 kind 取；出口箭头同色", () => {
  const glow = layer(NETWORK_MAP_LAYERS.linkGlow);
  assert.ok(glow.paint["line-blur"] >= 4);
  assert.deepEqual(glow.paint["line-color"], kindColorExpression(colors));
  assert.deepEqual(kindColorExpression(colors), ["match", ["get", "kind"], "main", "#3b82f6", "degraded", "#f59e0b", "down", "#ef4444", "#cbd5e1"]);
  const main = layer(NETWORK_MAP_LAYERS.linkMain);
  assert.deepEqual(main.filter, ["==", ["get", "kind"], "main"]);
  assert.deepEqual(main.paint["line-gradient"], linkGradient(colors));
  assert.deepEqual(linkGradient(colors), ["interpolate", ["linear"], ["line-progress"], 0, "#3b82f6", 1, lighten("#3b82f6", 0.4)]);
  assert.equal((style.sources[NETWORK_MAP_SOURCES.links] as any).lineMetrics, true);
  const dashed = layer(NETWORK_MAP_LAYERS.linkDashed);
  assert.deepEqual(dashed.filter, ["!=", ["get", "kind"], "main"]);
  assert.ok(Array.isArray(dashed.paint["line-dasharray"]));
  const arrows = layer(NETWORK_MAP_LAYERS.arrows);
  assert.equal(arrows.type, "fill");
  assert.deepEqual(arrows.paint["fill-color"], ["match", ["get", "kind"], "main", lighten("#3b82f6", 0.4), "degraded", "#f59e0b", "down", "#ef4444", "#cbd5e1"], "主线路的箭头是渐变出口那头的颜色");
});

test("颜色工具", () => {
  assert.equal(lighten("#000000", 0.5), "#808080");
  assert.equal(lighten("rgb(0, 0, 0)", 0.5), "#808080");
  assert.equal(lighten("oklch(0.6 0.1 200)", 0.5), "oklch(0.6 0.1 200)", "认不出的写法原样返回");
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

test("地球图 5.5 级以上不画（图层 maxzoom，连瓦片都不要），4.5 → 5.5 级淡出、矢量陆地和国界同时接上", () => {
  assert.deepEqual(TEXTURE_FADE_ZOOM, [4.5, 5.5]);
  const night = layer(NETWORK_MAP_LAYERS.night);
  assert.equal(night.maxzoom, TEXTURE_LAYER_MAX_ZOOM);
  assert.equal(at(night.paint["raster-opacity"], TEXTURE_FADE_ZOOM[1]), 0);
  assert.equal(at(LAND_OPACITY, 3), 0, "远看是夜光图，不画陆地");
  assert.equal(at(BORDER_OPACITY, 3), 0.5, "夜光图上一道淡淡的国界");
  assert.equal(at(LAND_OPACITY, TEXTURE_FADE_ZOOM[1]), 1, "地球图淡没时陆地接满");
  assert.equal(at(BORDER_OPACITY, TEXTURE_FADE_ZOOM[1]), 1);
});

test("110m 国界放大后对不上真实海岸线（珠江口的三角缺口）：陆地和国界 5.5 → 7 级淡下去", () => {
  assert.deepEqual(COARSE_COAST_ZOOM, [5.5, 7]);
  assert.equal(at(LAND_OPACITY, COARSE_COAST_ZOOM[0]), 1);
  assert.ok(at(LAND_OPACITY, COARSE_COAST_ZOOM[1]) <= 0.2);
  assert.ok(at(BORDER_OPACITY, COARSE_COAST_ZOOM[1]) <= 0.2);
});

test("按级别插值的透明度：级别严格递增（MapLibre 不认重复的级别，整层都不画）", () => {
  for (const [label, expression] of [["陆地", LAND_OPACITY], ["国界", BORDER_OPACITY], ["地球图", nightTonePaint()["raster-opacity"]]] as const) {
    const inputs = ((expression as unknown[]).slice(3) as number[]).filter((_, index) => index % 2 === 0);
    for (let i = 1; i < inputs.length; i += 1) assert.ok(inputs[i] > inputs[i - 1], `${label}：${JSON.stringify(expression)}`);
  }
});
