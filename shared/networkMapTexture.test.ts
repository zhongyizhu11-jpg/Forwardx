import assert from "node:assert/strict";
import test from "node:test";

import { NETWORK_MAP_NIGHT_TEXTURE_URL, NETWORK_MAP_NIGHT_TILE_URL, gradeNightPixels, nightLightGain, latToSourceY, mercatorYToLat, parseTextureTileUrl, textureTilePlan } from "./networkMapTexture";

test("墨卡托 y 换纬度：正中是赤道，两头是 ±85.05°", () => {
  assert.ok(Math.abs(mercatorYToLat(0.5)) < 1e-9);
  assert.ok(Math.abs(mercatorYToLat(0) - 85.0511) < 1e-3);
  assert.ok(Math.abs(mercatorYToLat(1) + 85.0511) < 1e-3);
  assert.equal(latToSourceY(90, 2048), 0);
  assert.equal(latToSourceY(0, 2048), 1024);
  assert.equal(latToSourceY(-90, 2048), 2048);
});

test("第 0 级一块瓦片就是整个世界：横向取整张图，纵向从 85° 到 −85°", () => {
  const plan = textureTilePlan(0, 0, 0, 256, 4096, 2048);
  assert.equal(plan.sx, 0);
  assert.equal(plan.sw, 4096);
  assert.equal(plan.rows.length, 256);
  assert.ok(Math.abs(plan.rows[0].sy - latToSourceY(85.0511, 2048)) < 0.1);
  const last = plan.rows[255];
  assert.ok(Math.abs(last.sy + last.sh - latToSourceY(-85.0511, 2048)) < 0.1);
  // 墨卡托在高纬度拉得更开：瓦片顶上一行对应的原图比赤道那行少
  assert.ok(plan.rows[0].sh < plan.rows[128].sh);
  // 行与行首尾相接，没有缝
  for (let index = 1; index < 200; index += 1) assert.ok(Math.abs(plan.rows[index - 1].sy + plan.rows[index - 1].sh - plan.rows[index].sy) < 1e-6 || plan.rows[index - 1].sh === 0.5);
});

test("横向按经度切、x 按世界宽度回绕；纵向超出范围的夹到边上", () => {
  const plan = textureTilePlan(2, 3, 1, 256, 4096, 2048);
  assert.equal(plan.sw, 1024);
  assert.equal(plan.sx, 3072);
  assert.equal(textureTilePlan(2, -1, 1, 256, 4096, 2048).sx, 3072, "x = −1 是左边那份世界里最右的一块");
  assert.equal(textureTilePlan(2, 4, 1, 256, 4096, 2048).sx, 0);
  assert.deepEqual(textureTilePlan(2, 0, 9, 256, 4096, 2048).rows, textureTilePlan(2, 0, 3, 256, 4096, 2048).rows);
});

test("高纬度原图不到一行也给 0.5 像素：drawImage 源高度为 0 什么都不画", () => {
  const plan = textureTilePlan(6, 0, 0, 256, 4096, 2048);
  assert.ok(plan.rows.every((row) => row.sh >= 0.5));
});

test("瓦片地址：fxearth://night/3/5/2", () => {
  assert.deepEqual(parseTextureTileUrl("fxearth://night/3/5/2"), { texture: "night", z: 3, x: 5, y: 2 });
  // 底图只有夜光图这一张：瓦片模板和图的地址
  assert.equal(NETWORK_MAP_NIGHT_TILE_URL, "fxearth://night/{z}/{x}/{y}");
  assert.equal(NETWORK_MAP_NIGHT_TEXTURE_URL, "/globe/earth-night.jpg");
  assert.equal(parseTextureTileUrl("https://example.com/3/5/2"), null);
  assert.equal(parseTextureTileUrl("fxearth://night/3/5"), null);
});

test("夜光图调色：海压暗成深海军蓝，灰白的灯变成更亮的暖色，纯黑还是黑", () => {
  const data = new Uint8ClampedArray([1, 19, 40, 255, 92, 93, 92, 255, 0, 0, 0, 255]);
  gradeNightPixels(data);
  assert.ok(data[0] < 2 && data[1] < 19 && data[2] < 40 && data[2] > data[1], "海：更暗、还是蓝的");
  assert.ok(data[4] > 150 && data[4] > data[5] && data[5] > data[6], "灯：更亮、偏橙黄");
  assert.deepEqual([data[8], data[9], data[10], data[11]], [0, 0, 0, 255]);
});

test("夜光图的光：缩得越小加得越多", () => {
  assert.ok(nightLightGain(1) > nightLightGain(3) && nightLightGain(3) > nightLightGain(4));
  const far = new Uint8ClampedArray([92, 93, 92, 255]);
  const near = new Uint8ClampedArray([92, 93, 92, 255]);
  gradeNightPixels(far, nightLightGain(1));
  gradeNightPixels(near, nightLightGain(4));
  assert.ok(far[0] > near[0]);
});
