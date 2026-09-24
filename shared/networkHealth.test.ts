import assert from "node:assert/strict";
import test from "node:test";

import {
  describeNetworkHealth,
  fromLegacyTone,
  networkHealthPriority,
  resolveNetworkHealth,
  rollUpNetworkHealth,
  type NetworkHealth,
} from "./networkHealth";

test("没上报过是 unknown，不是 healthy", () => {
  // 这是整套词汇表最要紧的一条：拿不到数据时不能替它填「正常」，
  // 否则一台已经失联的机器在面板上是绿的。
  assert.equal(resolveNetworkHealth({}), "unknown");
  assert.equal(resolveNetworkHealth({ reachable: undefined }), "unknown");
});

test("上报过但过期了，回到 unknown 而不是沿用旧结论", () => {
  assert.equal(
    resolveNetworkHealth({ reachable: true, lastSeenAgeSeconds: 900, staleAfterSeconds: 600 }),
    "unknown",
  );
  assert.equal(
    resolveNetworkHealth({ reachable: true, lastSeenAgeSeconds: 300, staleAfterSeconds: 600 }),
    "healthy",
  );
});

test("停用和切换优先于可达性", () => {
  // 一台停用的机器探不通是理所当然的，不该报故障。
  assert.equal(resolveNetworkHealth({ standby: true, reachable: false }), "standby");
  assert.equal(resolveNetworkHealth({ switching: true, reachable: true }), "switching");
});

test("探测失败是 down，指标越界是 degraded", () => {
  assert.equal(resolveNetworkHealth({ reachable: false }), "down");
  assert.equal(resolveNetworkHealth({ reachable: true, degraded: true }), "degraded");
  assert.equal(resolveNetworkHealth({ reachable: true }), "healthy");
});

test("汇总按「最该先看到哪个」排，切换中排在故障前面", () => {
  assert.equal(rollUpNetworkHealth(["healthy", "down", "switching"]), "switching");
  assert.equal(rollUpNetworkHealth(["healthy", "down", "degraded"]), "down");
  assert.equal(rollUpNetworkHealth(["healthy", "degraded"]), "degraded");
  assert.equal(rollUpNetworkHealth(["healthy", "standby"]), "standby");
  assert.equal(rollUpNetworkHealth(["healthy", "healthy"]), "healthy");
});

test("汇总一个空集合是 unknown，不是 healthy", () => {
  // 零个成员不代表一切正常，代表什么都不知道。
  assert.equal(rollUpNetworkHealth([]), "unknown");
  assert.equal(rollUpNetworkHealth([null, undefined]), "unknown");
});

test("unknown 混在里面时压过 standby 和 healthy", () => {
  assert.equal(rollUpNetworkHealth(["healthy", "standby", "unknown"]), "unknown");
});

test("排序用的优先级和汇总是同一个顺序", () => {
  // 首页「需要关注」按这个排；两处各写一份顺序的话，列表第一行和汇总的颜色迟早对不上。
  const all: NetworkHealth[] = ["healthy", "degraded", "down", "standby", "switching", "unknown"];
  for (const a of all) {
    for (const b of all) {
      const first = networkHealthPriority(a) <= networkHealthPriority(b) ? a : b;
      assert.equal(rollUpNetworkHealth([a, b]), first, `${a} / ${b}`);
    }
  }
  assert.equal(
    networkHealthPriority("nonsense" as never),
    networkHealthPriority("unknown"),
    "认不出来的按 unknown 排，不能因为认不出来就沉到最底下",
  );
});

test("每个状态都带着自己的线型和是否需要处理", () => {
  assert.equal(describeNetworkHealth("healthy").lineStyle, "solid");
  assert.equal(describeNetworkHealth("standby").lineStyle, "dashed");
  assert.equal(describeNetworkHealth("switching").lineStyle, "pulse");

  assert.equal(describeNetworkHealth("healthy").needsAttention, false);
  assert.equal(describeNetworkHealth("standby").needsAttention, false);
  // 「没上报」要进「需要关注」—— 它是一个待查的问题，不是一切正常。
  assert.equal(describeNetworkHealth("unknown").needsAttention, true);
  assert.equal(describeNetworkHealth("down").needsAttention, true);
  assert.equal(describeNetworkHealth("degraded").needsAttention, true);
});

test("认不出来的输入回落到 unknown，而不是抛错或回 healthy", () => {
  assert.equal(describeNetworkHealth(null).health, "unknown");
  assert.equal(describeNetworkHealth("nonsense" as never).health, "unknown");
  assert.equal(fromLegacyTone("nonsense"), "unknown");
});

test("V1 的 offline 映射到 down 而不是 standby", () => {
  // V1 的 offline 混了「掉线」和「停用」，掉线是更该被看到的那个。
  assert.equal(fromLegacyTone("online"), "healthy");
  assert.equal(fromLegacyTone("warning"), "degraded");
  assert.equal(fromLegacyTone("offline"), "down");
});
