import assert from "node:assert/strict";
import test from "node:test";

import {
  NETWORK_MAP_BASE_LAYERS,
  NETWORK_MAP_BASE_LAYER_ORDER,
  defaultNetworkMapBaseLayer,
  networkMapSkin,
  resolveNetworkMapBaseLayer,
} from "./networkMapBaseLayers";

test("三种底图：简洁底图自绘、不转坐标；高德两种走瓦片、要转坐标", () => {
  assert.deepEqual(NETWORK_MAP_BASE_LAYER_ORDER, ["vector", "light", "sat"]);
  const vector = NETWORK_MAP_BASE_LAYERS.vector;
  assert.equal(vector.amap, false);
  assert.equal(vector.vector, true);
  assert.equal(vector.tiles.length, 0);

  const light = NETWORK_MAP_BASE_LAYERS.light;
  assert.equal(light.amap, true);
  assert.equal(light.vector, false);
  assert.equal(light.tiles.length, 1);
  assert.equal(light.tiles[0].urls.length, 4, "四个子域轮流拉");
  assert.match(light.tiles[0].urls[0], /^https:\/\/webrd01\.is\.autonavi\.com\/appmaptile\?lang=zh_cn&size=1&scale=1&style=7&x=\{x\}&y=\{y\}&z=\{z\}$/);
  assert.equal(light.tiles[0].tileSize, 256);
  assert.equal(light.tiles[0].maxzoom, 18);

  const sat = NETWORK_MAP_BASE_LAYERS.sat;
  assert.equal(sat.tiles.length, 2, "影像 + 路网标注");
  assert.match(sat.tiles[0].urls[1], /webst02.*style=6/);
  assert.match(sat.tiles[1].urls[3], /webst04.*style=8/);
});

test("皮肤：简洁和高德标准跟面板主题，卫星永远深色", () => {
  assert.equal(networkMapSkin("vector", "light"), "light");
  assert.equal(networkMapSkin("vector", "dark"), "dark");
  assert.equal(networkMapSkin("light", "dark"), "dark");
  assert.equal(networkMapSkin("light", "light"), "light");
  assert.equal(networkMapSkin("sat", "light"), "dark");
});

test("默认是简洁底图；亲手选过高德的照旧，老的「暗黑网格」落到简洁底图，坏值退回默认", () => {
  assert.equal(defaultNetworkMapBaseLayer(), "vector");
  assert.equal(resolveNetworkMapBaseLayer(null), "vector");
  assert.equal(resolveNetworkMapBaseLayer("sat"), "sat");
  assert.equal(resolveNetworkMapBaseLayer("light"), "light");
  assert.equal(resolveNetworkMapBaseLayer("dark"), "vector");
  assert.equal(resolveNetworkMapBaseLayer("osm"), "vector");
});
