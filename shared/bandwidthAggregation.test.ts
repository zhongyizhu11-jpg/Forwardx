import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateRecordSlots,
  buildBandwidthAggregationPlan,
  formatBandwidthMbps,
  interleaveRecordValues,
  normalizeAggregationMinMembers,
  normalizeAggregationRecordSlots,
  normalizeBandwidthAggregationStrategy,
  normalizeMemberBandwidthMbps,
  normalizeMemberWeight,
} from "./bandwidthAggregation";

function member(overrides: Partial<Parameters<typeof buildBandwidthAggregationPlan>[0][number]> = {}) {
  return {
    memberId: 1,
    value: "10.0.0.1",
    bandwidthMbps: 100,
    healthy: true,
    ...overrides,
  };
}

test("strategy normalization falls back to capacity", () => {
  assert.equal(normalizeBandwidthAggregationStrategy("adaptive"), "adaptive");
  assert.equal(normalizeBandwidthAggregationStrategy("  EQUAL "), "equal");
  assert.equal(normalizeBandwidthAggregationStrategy("nope"), "capacity");
  assert.equal(normalizeBandwidthAggregationStrategy(null), "capacity");
});

test("member bandwidth and weight are clamped to sane bounds", () => {
  assert.equal(normalizeMemberBandwidthMbps("1000"), 1000);
  assert.equal(normalizeMemberBandwidthMbps(-5), 0);
  assert.equal(normalizeMemberBandwidthMbps(1e9), 100_000);
  assert.equal(normalizeMemberBandwidthMbps("abc"), 0);
  assert.equal(normalizeMemberWeight(7), 7);
  assert.equal(normalizeMemberWeight(500), 100);
  assert.equal(normalizeMemberWeight(-1), 0);
});

test("record slot and minimum member options are bounded", () => {
  assert.equal(normalizeAggregationRecordSlots(0), 8);
  assert.equal(normalizeAggregationRecordSlots(3), 3);
  assert.equal(normalizeAggregationRecordSlots(999), 32);
  assert.equal(normalizeAggregationMinMembers(0), 1);
  assert.equal(normalizeAggregationMinMembers(9), 5);
  assert.equal(normalizeAggregationMinMembers(3), 3);
});

test("largest-remainder slot allocation stays proportional and exact", () => {
  assert.deepEqual(allocateRecordSlots([0.5, 0.25, 0.25], 8), [4, 2, 2]);
  assert.equal(allocateRecordSlots([0.7, 0.3], 10).reduce((sum, value) => sum + value, 0), 10);
  assert.deepEqual(allocateRecordSlots([0.9, 0.1], 2), [1, 1]);
  // Fewer slots than members: the biggest shares win.
  assert.deepEqual(allocateRecordSlots([0.1, 0.6, 0.3], 2), [0, 1, 1]);
  assert.deepEqual(allocateRecordSlots([], 8), []);
  assert.deepEqual(allocateRecordSlots([0, 0], 4), [0, 0]);
});

test("record values interleave instead of grouping one member together", () => {
  assert.deepEqual(
    interleaveRecordValues([{ value: "a", slots: 3 }, { value: "b", slots: 1 }]),
    ["a", "b", "a", "a"],
  );
  assert.deepEqual(interleaveRecordValues([{ value: "a", slots: 0 }]), []);
});

test("capacity strategy splits slots in proportion to declared bandwidth", () => {
  const plan = buildBandwidthAggregationPlan([
    member({ memberId: 1, value: "1.1.1.1", bandwidthMbps: 300 }),
    member({ memberId: 2, value: "2.2.2.2", bandwidthMbps: 100 }),
  ], { strategy: "capacity", recordSlots: 8 });

  assert.equal(plan.enabled, true);
  assert.equal(plan.degraded, false);
  assert.equal(plan.aggregateCapacityMbps, 400);
  const [first, second] = plan.members;
  assert.equal(first.memberId, 1);
  assert.equal(first.recordSlots, 6);
  assert.equal(second.recordSlots, 2);
  assert.equal(plan.recordValues.length, 8);
  assert.equal(plan.recordValues.filter((value) => value === "1.1.1.1").length, 6);
});

test("equal strategy ignores bandwidth differences", () => {
  const plan = buildBandwidthAggregationPlan([
    member({ memberId: 1, value: "1.1.1.1", bandwidthMbps: 1000, weight: 90 }),
    member({ memberId: 2, value: "2.2.2.2", bandwidthMbps: 50 }),
  ], { strategy: "equal", recordSlots: 8 });

  assert.deepEqual(plan.members.map((entry) => entry.recordSlots), [4, 4]);
});

test("manual weights drive the weighted strategy", () => {
  const plan = buildBandwidthAggregationPlan([
    member({ memberId: 1, value: "1.1.1.1", bandwidthMbps: 50, weight: 3 }),
    member({ memberId: 2, value: "2.2.2.2", bandwidthMbps: 900, weight: 1 }),
  ], { strategy: "weighted", recordSlots: 8 });

  const byId = new Map(plan.members.map((entry) => [entry.memberId, entry]));
  assert.equal(byId.get(1)!.recordSlots, 6);
  assert.equal(byId.get(2)!.recordSlots, 2);
});

test("adaptive strategy shifts share toward members with headroom", () => {
  const plan = buildBandwidthAggregationPlan([
    member({ memberId: 1, value: "1.1.1.1", bandwidthMbps: 200, usedMbps: 190 }),
    member({ memberId: 2, value: "2.2.2.2", bandwidthMbps: 200, usedMbps: 20 }),
  ], { strategy: "adaptive", recordSlots: 10 });

  const byId = new Map(plan.members.map((entry) => [entry.memberId, entry]));
  assert.ok(byId.get(2)!.share > byId.get(1)!.share);
  assert.ok(byId.get(1)!.recordSlots >= 1, "a saturated member keeps a floor share");
  assert.equal(plan.aggregateUsedMbps, 210);
  assert.equal(plan.aggregateAvailableMbps, 190);
  assert.equal(Math.round(plan.utilization * 100), 53);
});

test("unhealthy members leave the distribution but stay reported", () => {
  const plan = buildBandwidthAggregationPlan([
    member({ memberId: 1, value: "1.1.1.1", bandwidthMbps: 200 }),
    member({ memberId: 2, value: "2.2.2.2", bandwidthMbps: 200, healthy: false }),
  ], { strategy: "capacity", recordSlots: 8 });

  assert.equal(plan.healthyCount, 1);
  assert.equal(plan.aggregateCapacityMbps, 200);
  assert.deepEqual(new Set(plan.recordValues), new Set(["1.1.1.1"]));
  const unhealthy = plan.members.find((entry) => entry.memberId === 2)!;
  assert.equal(unhealthy.healthy, false);
  assert.equal(unhealthy.recordSlots, 0);
  assert.equal(unhealthy.share, 0);
});

test("members without a declared uplink borrow the median capacity", () => {
  const plan = buildBandwidthAggregationPlan([
    member({ memberId: 1, value: "1.1.1.1", bandwidthMbps: 100 }),
    member({ memberId: 2, value: "2.2.2.2", bandwidthMbps: 300 }),
    member({ memberId: 3, value: "3.3.3.3", bandwidthMbps: 0 }),
  ], { strategy: "capacity", recordSlots: 8 });

  const blank = plan.members.find((entry) => entry.memberId === 3)!;
  assert.equal(blank.bandwidthMbps, 0);
  assert.equal(blank.effectiveBandwidthMbps, 200);
  assert.ok(blank.share > 0);
});

test("aggregation degrades to equal shares below the healthy-member floor", () => {
  const plan = buildBandwidthAggregationPlan([
    member({ memberId: 1, value: "1.1.1.1", bandwidthMbps: 900 }),
    member({ memberId: 2, value: "2.2.2.2", bandwidthMbps: 100, healthy: false }),
  ], { strategy: "capacity", recordSlots: 8, minHealthyMembers: 2 });

  assert.equal(plan.degraded, true);
  assert.match(plan.reason, /聚合下限/);
  assert.equal(plan.members[0].recordSlots, 8);
});

test("disabled aggregation publishes one equal slot per healthy member", () => {
  const plan = buildBandwidthAggregationPlan([
    member({ memberId: 1, value: "1.1.1.1", bandwidthMbps: 900 }),
    member({ memberId: 2, value: "2.2.2.2", bandwidthMbps: 100 }),
  ], { enabled: false, strategy: "capacity", recordSlots: 8 });

  assert.equal(plan.enabled, false);
  assert.deepEqual(plan.members.map((entry) => entry.recordSlots), [4, 4]);
});

test("single-value records emit one entry per member ordered by share", () => {
  const plan = buildBandwidthAggregationPlan([
    member({ memberId: 1, value: "a.example.com", bandwidthMbps: 100 }),
    member({ memberId: 2, value: "b.example.com", bandwidthMbps: 400 }),
  ], { strategy: "capacity", singleValuePerMember: true });

  assert.deepEqual(plan.recordValues, ["b.example.com", "a.example.com"]);
});

test("a group rate limit is split across members by share", () => {
  const plan = buildBandwidthAggregationPlan([
    member({ memberId: 1, value: "1.1.1.1", bandwidthMbps: 300 }),
    member({ memberId: 2, value: "2.2.2.2", bandwidthMbps: 100 }),
  ], { strategy: "capacity", rateLimitMbps: 400 });

  const byId = new Map(plan.members.map((entry) => [entry.memberId, entry]));
  assert.equal(byId.get(1)!.rateLimitMbps, 300);
  assert.equal(byId.get(2)!.rateLimitMbps, 100);
});

test("an empty member list produces an idle plan", () => {
  const plan = buildBandwidthAggregationPlan([], { strategy: "capacity" });
  assert.equal(plan.healthyCount, 0);
  assert.equal(plan.aggregateCapacityMbps, 0);
  assert.deepEqual(plan.recordValues, []);
  assert.match(plan.reason, /没有健康的前置主机/);
});

test("members without an address are skipped", () => {
  const plan = buildBandwidthAggregationPlan([
    member({ memberId: 1, value: "" }),
    member({ memberId: 2, value: "2.2.2.2" }),
  ], { strategy: "capacity" });
  assert.equal(plan.members.length, 1);
  assert.equal(plan.members[0].memberId, 2);
});

test("bandwidth formatting switches to Gbps past 1000 Mbps", () => {
  assert.equal(formatBandwidthMbps(0), "-");
  assert.equal(formatBandwidthMbps(500), "500 Mbps");
  assert.equal(formatBandwidthMbps(1500), "1.5 Gbps");
  assert.equal(formatBandwidthMbps(20000), "20 Gbps");
});
