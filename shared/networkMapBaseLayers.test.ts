import assert from "node:assert/strict";
import test from "node:test";

import {
  NETWORK_MAP_BASE_LAYERS,
  NETWORK_MAP_BASE_LAYER_ORDER,
  defaultNetworkMapBaseLayer,
  graticuleGeoJson,
  resolveNetworkMapBaseLayer,
} from "./networkMapBaseLayers";

test("三种底图：高德两种走瓦片、要转坐标；暗黑网格自绘、不转", () => {
  assert.deepEqual(NETWORK_MAP_BASE_LAYER_ORDER, ["light", "dark", "sat"]);
  const light = NETWORK_MAP_BASE_LAYERS.light;
  assert.equal(light.amap, true);
  assert.equal(light.skin, "light");
  assert.equal(light.tiles.length, 1);
  assert.equal(light.tiles[0].urls.length, 4, "四个子域轮流拉");
  assert.match(light.tiles[0].urls[0], /^https:\/\/webrd01\.is\.autonavi\.com\/appmaptile\?lang=zh_cn&size=1&scale=1&style=7&x=\{x\}&y=\{y\}&z=\{z\}$/);
  assert.equal(light.tiles[0].tileSize, 256);
  assert.equal(light.tiles[0].maxzoom, 18);

  const sat = NETWORK_MAP_BASE_LAYERS.sat;
  assert.equal(sat.skin, "dark");
  assert.equal(sat.tiles.length, 2, "影像 + 路网标注");
  assert.match(sat.tiles[0].urls[1], /webst02.*style=6/);
  assert.match(sat.tiles[1].urls[3], /webst04.*style=8/);

  const dark = NETWORK_MAP_BASE_LAYERS.dark;
  assert.equal(dark.amap, false);
  assert.equal(dark.tiles.length, 0);
  assert.equal(dark.water, "#0B0F19");
  assert.equal(dark.graticule, true);
});

test("默认跟主题走，记住的合法值优先，坏值退回默认", () => {
  assert.equal(defaultNetworkMapBaseLayer("dark"), "dark");
  assert.equal(defaultNetworkMapBaseLayer("light"), "light");
  assert.equal(resolveNetworkMapBaseLayer("sat", "light"), "sat");
  assert.equal(resolveNetworkMapBaseLayer("osm", "dark"), "dark");
  assert.equal(resolveNetworkMapBaseLayer(null, "light"), "light");
});

test("15° 经纬网格：25 条经线 + 11 条纬线", () => {
  const geo = graticuleGeoJson();
  assert.equal(geo.features[0].geometry.coordinates.length, 25 + 11);
});
