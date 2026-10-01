import assert from "node:assert/strict";
import test from "node:test";

import {
  NETWORK_MAP_ALL_BASE_LAYERS,
  NETWORK_MAP_BASE_LAYERS,
  NETWORK_MAP_BASE_LAYER_ORDER,
  NETWORK_MAP_EXTRA_BASE_LAYERS,
  NETWORK_MAP_TEXTURE_URLS,
  defaultNetworkMapBaseLayer,
  resolveNetworkMapBaseLayer,
  textureTileUrl,
} from "./networkMapBaseLayers";

test("三段切换：标准地图（夜光）、卫星地图、暗黑网格；高德只在菜单里", () => {
  assert.deepEqual(NETWORK_MAP_BASE_LAYER_ORDER, ["night", "sat", "grid"]);
  assert.deepEqual(NETWORK_MAP_EXTRA_BASE_LAYERS, ["amap"]);
  assert.deepEqual(NETWORK_MAP_ALL_BASE_LAYERS, ["night", "sat", "grid", "amap"]);
  assert.deepEqual(NETWORK_MAP_BASE_LAYER_ORDER.map((id) => NETWORK_MAP_BASE_LAYERS[id].label), ["标准地图", "卫星地图", "暗黑网格"]);
});

test("离线底图不转坐标、不拉瓦片；夜光和卫星各用一张地球图，暗黑网格自绘陆地和经纬网", () => {
  const night = NETWORK_MAP_BASE_LAYERS.night;
  assert.equal(night.amap, false);
  assert.equal(night.tiles.length, 0);
  assert.equal(night.texture, "night");
  assert.equal(night.land, false);
  assert.equal(NETWORK_MAP_BASE_LAYERS.sat.texture, "day");
  assert.equal(NETWORK_MAP_BASE_LAYERS.grid.texture, null);
  assert.equal(NETWORK_MAP_BASE_LAYERS.grid.land, true);
  assert.equal(NETWORK_MAP_BASE_LAYERS.grid.graticule, true);
  assert.equal(NETWORK_MAP_TEXTURE_URLS.night, "/globe/earth-night.jpg");
  assert.equal(NETWORK_MAP_TEXTURE_URLS.day, "/globe/earth-blue-marble.jpg");
  assert.equal(textureTileUrl("night"), "fxearth://night/{z}/{x}/{y}");
});

test("高德要转坐标、走瓦片，四个子域轮流拉", () => {
  const amap = NETWORK_MAP_BASE_LAYERS.amap;
  assert.equal(amap.amap, true);
  assert.equal(amap.tiles.length, 1);
  assert.equal(amap.tiles[0].urls.length, 4);
  assert.match(amap.tiles[0].urls[0], /^https:\/\/webrd01\.is\.autonavi\.com\/appmaptile\?lang=zh_cn&size=1&scale=1&style=7&x=\{x\}&y=\{y\}&z=\{z\}$/);
});

test("默认是夜晚的地球；老版本记住的值换成现在的叫法，坏值退回默认", () => {
  assert.equal(defaultNetworkMapBaseLayer(), "night");
  assert.equal(resolveNetworkMapBaseLayer(null), "night");
  assert.equal(resolveNetworkMapBaseLayer("vector"), "night");
  assert.equal(resolveNetworkMapBaseLayer("dark"), "grid");
  assert.equal(resolveNetworkMapBaseLayer("light"), "amap");
  assert.equal(resolveNetworkMapBaseLayer("sat"), "sat");
  assert.equal(resolveNetworkMapBaseLayer("grid"), "grid");
  assert.equal(resolveNetworkMapBaseLayer("osm"), "night");
});
