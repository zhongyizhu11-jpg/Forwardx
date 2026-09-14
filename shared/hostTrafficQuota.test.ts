import assert from "node:assert/strict";
import test from "node:test";

import {
  hostTrafficPercent,
  hostTrafficUsedBytes,
  normalizeHostTrafficMeasureMode,
} from "./hostTrafficQuota";

test("认不出来的计量口径一律当双向 —— 那是算出来最大的一个", () => {
  assert.equal(normalizeHostTrafficMeasureMode("both"), "both");
  assert.equal(normalizeHostTrafficMeasureMode("outbound"), "outbound");
  assert.equal(normalizeHostTrafficMeasureMode("max"), "max");
  for (const bad of [undefined, null, "", "BOTH", "inbound", 3, {}]) {
    assert.equal(
      normalizeHostTrafficMeasureMode(bad),
      "both",
      "认不出的口径要往保守的那边倒，不能悄悄按仅出向算 —— 那会把已用量报小",
    );
  }
});

test("三种口径各算各的", () => {
  const traffic = { bytesIn: 300, bytesOut: 700 };
  assert.equal(hostTrafficUsedBytes(traffic, "both"), 1000);
  assert.equal(hostTrafficUsedBytes(traffic, "outbound"), 700);
  assert.equal(hostTrafficUsedBytes(traffic, "max"), 700);
  assert.equal(hostTrafficUsedBytes({ bytesIn: 900, bytesOut: 100 }, "max"), 900);
});

test("还没有计数时是 0，不是猜一个", () => {
  assert.equal(hostTrafficUsedBytes(null, "both"), 0);
  assert.equal(hostTrafficUsedBytes(undefined, "both"), 0);
  assert.equal(hostTrafficUsedBytes({}, "both"), 0);
});

test("负数和脏值不能把已用量倒扣回去", () => {
  assert.equal(hostTrafficUsedBytes({ bytesIn: -500, bytesOut: 200 }, "both"), 200);
  assert.equal(hostTrafficUsedBytes({ bytesIn: "abc", bytesOut: 100 }, "both"), 100);
  assert.equal(hostTrafficUsedBytes({ bytesIn: NaN, bytesOut: NaN }, "max"), 0);
});

test("没设额度就没有百分比 —— 那和 0% 是两回事", () => {
  assert.equal(hostTrafficPercent(500, 0), null);
  assert.equal(hostTrafficPercent(500, null), null);
  assert.equal(hostTrafficPercent(0, 1000), 0);
  assert.equal(hostTrafficPercent(780, 1000), 78);
  assert.equal(hostTrafficPercent(1500, 1000), 150, "超了就照实说超了，不封在 100");
});
