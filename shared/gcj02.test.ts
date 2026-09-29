import assert from "node:assert/strict";
import test from "node:test";

import { isInMainlandChina, wgs84ToGcj02 } from "./gcj02";

test("天安门：WGS-84 转成 GCJ-02 后落在已知的火星坐标上", () => {
  const [lng, lat] = wgs84ToGcj02(116.3912, 39.9075);
  assert.ok(Math.abs(lng - 116.3975) < 0.0005, `lng ${lng}`);
  assert.ok(Math.abs(lat - 39.9088) < 0.0005, `lat ${lat}`);
});

test("广州的点会偏，偏移量在几百米量级", () => {
  const [lng, lat] = wgs84ToGcj02(113.264, 23.129);
  const dLng = Math.abs(lng - 113.264);
  const dLat = Math.abs(lat - 23.129);
  assert.ok(dLng > 0.001 && dLng < 0.01, `lng 偏 ${dLng}`);
  assert.ok(dLat > 0.0005 && dLat < 0.01, `lat 偏 ${dLat}`);
});

test("港澳台和海外的点不动", () => {
  assert.deepEqual(wgs84ToGcj02(114.169, 22.319), [114.169, 22.319], "香港");
  assert.deepEqual(wgs84ToGcj02(113.55, 22.19), [113.55, 22.19], "澳门");
  assert.deepEqual(wgs84ToGcj02(121.565, 25.033), [121.565, 25.033], "台北");
  assert.deepEqual(wgs84ToGcj02(-118.243, 34.052), [-118.243, 34.052], "洛杉矶");
  assert.deepEqual(wgs84ToGcj02(139.69, 35.69), [139.69, 35.69], "东京");
  assert.deepEqual(wgs84ToGcj02(103.82, 1.352), [103.82, 1.352], "新加坡");
  assert.deepEqual(wgs84ToGcj02(126.98, 37.57), [126.98, 37.57], "首尔");
  assert.deepEqual(wgs84ToGcj02(135.5, 34.69), [135.5, 34.69], "大阪");
  assert.notDeepEqual(wgs84ToGcj02(110.35, 20.02), [110.35, 20.02], "海口要转");
  assert.notDeepEqual(wgs84ToGcj02(124.39, 40.12), [124.39, 40.12], "丹东要转");
});

test("大陆判定：内地在、港台不在、坏坐标不在", () => {
  assert.equal(isInMainlandChina(116.39, 39.9), true);
  assert.equal(isInMainlandChina(114.169, 22.319), false);
  assert.equal(isInMainlandChina(121.5, 25.0), false);
  assert.equal(isInMainlandChina(Number.NaN, 30), false);
});
