import assert from "node:assert/strict";
import test from "node:test";

import {
  NETWORK_MAP_DASH_STEPS,
  NETWORK_MAP_LAYERS,
  baseLayerPaintPatch,
  buildNetworkMapStyle,
  cometPaint,
  cometTailGradient,
  dimOpacityExpression,
  rasterSourceIds,
  rasterVisibility,
} from "./networkMapStyle";

const colors = { healthy: "#06b6d4", warn: "#f59e0b", down: "#ef4444", standby: "#94a3b8" };

test("一份样式装下三种底图：所有栅格源都在，只有激活的那个可见", () => {
  const style = buildNetworkMapStyle("sat", "/globe/x.geojson", colors);
  const ids = rasterSourceIds();
  assert.deepEqual(ids, ["amap-road", "amap-sat", "amap-sat-labels"]);
  for (const id of ids) assert.ok(style.sources[id], `源 ${id} 在样式里`);
  const visibility = Object.fromEntries(style.layers.filter((layer: any) => layer.type === "raster").map((layer: any) => [layer.id, layer.layout.visibility]));
  assert.deepEqual(visibility, { "amap-road": "none", "amap-sat": "visible", "amap-sat-labels": "visible" });
  assert.deepEqual(rasterVisibility("dark"), { "amap-road": "none", "amap-sat": "none", "amap-sat-labels": "none" });
});

test("图层顺序：底色 → 瓦片 → 陆地 / 网格 / 国界 → 流向 → 光晕 → 线 → 光点", () => {
  const style = buildNetworkMapStyle("dark", "/globe/x.geojson", colors);
  const order = style.layers.map((layer: any) => layer.id);
  const index = (id: string) => order.indexOf(id);
  assert.ok(index(NETWORK_MAP_LAYERS.background) < index("amap-road"));
  assert.ok(index("amap-sat-labels") < index(NETWORK_MAP_LAYERS.land));
  assert.ok(index(NETWORK_MAP_LAYERS.borders) < index(NETWORK_MAP_LAYERS.flow));
  assert.ok(index(NETWORK_MAP_LAYERS.flow) < index(NETWORK_MAP_LAYERS.linkHalo));
  assert.ok(index(NETWORK_MAP_LAYERS.linkSolid) < index(NETWORK_MAP_LAYERS.linkFlow));
  const graticule = style.layers.find((layer: any) => layer.id === NETWORK_MAP_LAYERS.graticule) as any;
  assert.equal(graticule.layout.visibility, "visible", "暗黑网格画经纬网");
  assert.equal((style.layers[0] as any).paint["background-color"], "#0B0F19");
});

test("线要素的 promoteId 是 fid，聚焦用 feature-state 把无关的线压到 12%", () => {
  const style = buildNetworkMapStyle("light", "/globe/x.geojson", colors);
  assert.equal((style.sources["nm-links"] as any).promoteId, "fid");
  assert.deepEqual(dimOpacityExpression(1), ["*", 1, ["case", ["boolean", ["feature-state", "dim"], false], 0.12, 1]]);
});

test("换底图的补丁：卫星不画国界、标准图不画网格、暗黑网格恢复陆地", () => {
  assert.equal(baseLayerPaintPatch("sat").borderWidth, 0);
  assert.equal(baseLayerPaintPatch("light").graticule, "none");
  assert.equal(baseLayerPaintPatch("dark").landOpacity, 1);
  assert.equal(baseLayerPaintPatch("dark").raster["amap-road"], "none");
});

test("箭头和彗星压在线的上面：尾巴的渐变从透明到正常色，源开了 lineMetrics", () => {
  const style = buildNetworkMapStyle("dark", "/globe/x.geojson", colors);
  const order = style.layers.map((layer: any) => layer.id);
  const index = (id: string) => order.indexOf(id);
  assert.ok(index(NETWORK_MAP_LAYERS.linkFlow) < index(NETWORK_MAP_LAYERS.tip));
  assert.ok(index(NETWORK_MAP_LAYERS.tip) < index(NETWORK_MAP_LAYERS.cometTail));
  assert.ok(index(NETWORK_MAP_LAYERS.cometTail) < index(NETWORK_MAP_LAYERS.cometGlow));
  assert.ok(index(NETWORK_MAP_LAYERS.cometGlow) < index(NETWORK_MAP_LAYERS.cometHead));
  assert.equal((style.sources["nm-comets"] as any).lineMetrics, true);
  const tail = style.layers.find((layer: any) => layer.id === NETWORK_MAP_LAYERS.cometTail) as any;
  assert.deepEqual(tail.paint["line-gradient"], cometTailGradient(colors));
  assert.deepEqual(cometTailGradient(colors), ["interpolate", ["linear"], ["line-progress"], 0, "rgba(6,182,212,0)", 0.6, "rgba(6,182,212,0.55)", 1, "#06b6d4"]);
  assert.equal(cometPaint(colors).head["circle-stroke-color"], "#06b6d4");
});

test("流动光点的 dasharray 一圈 14 步，每步都是合法的 dash 数组", () => {
  assert.equal(NETWORK_MAP_DASH_STEPS.length, 14);
  for (const step of NETWORK_MAP_DASH_STEPS) {
    assert.ok(step.length === 3 || step.length === 4);
    for (const value of step) assert.ok(value >= 0);
  }
});
