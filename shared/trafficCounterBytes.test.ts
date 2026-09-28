import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTrafficCounterBytes, normalizeTrafficCounterConnections } from "./trafficCounterBytes";

test("负数和坏值当 0 —— 别让一次坏上报把已用流量倒扣回去", () => {
  for (const bad of [-1, -1e9, NaN, Infinity, -Infinity, "abc", null, undefined, {}]) {
    assert.equal(normalizeTrafficCounterBytes(bad), 0, `${String(bad)} 应该归零`);
  }
});

test("超出安全整数的截到上限 —— 历史明细和配额得是同一个数", () => {
  // 入库那层本来就截到 MAX_SAFE_INTEGER。计费这边不截的话，同一次上报会写出两个
  // 不同的数，而且用户的已用流量会被永久钉在超额线以上。
  assert.equal(normalizeTrafficCounterBytes(1e21), Number.MAX_SAFE_INTEGER);
  assert.equal(normalizeTrafficCounterBytes(Number.MAX_SAFE_INTEGER + 1000), Number.MAX_SAFE_INTEGER);
});

test("正常值原样通过，小数取整", () => {
  assert.equal(normalizeTrafficCounterBytes(1024), 1024);
  assert.equal(normalizeTrafficCounterBytes("2048"), 2048);
  assert.equal(normalizeTrafficCounterBytes(1024.9), 1024);
});

test("连接数同一套规矩", () => {
  assert.equal(normalizeTrafficCounterConnections(-50), 0);
  assert.equal(normalizeTrafficCounterConnections(3.7), 3);
});

test("单次上报的连接数截到 INT 上限 —— 明细表的 connections 还是 INT 列", () => {
  assert.equal(normalizeTrafficCounterConnections(1e12), 2147483647);
  assert.equal(normalizeTrafficCounterConnections(2147483647), 2147483647);
});
