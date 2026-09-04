import assert from "node:assert/strict";
import test from "node:test";
import {
  AGGREGATION_THROUGHPUT_SAMPLE_MAX_AGE_MS,
  applyAggregationToDdnsValues,
  buildEntryGroupAggregationPlan,
  hostThroughputMbpsFromSnapshots,
  isBandwidthAggregationGroup,
  resolveAggregationSettings,
  summarizeAggregationPlan,
} from "./bandwidthAggregation";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

function snapshot(hostId: number, offsetMs: number, bytes: { in: number; out: number }) {
  return {
    hostId,
    networkIn: bytes.in,
    networkOut: bytes.out,
    recordedAt: new Date(NOW - offsetMs),
  };
}

function aggregationGroup(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    groupMode: "entry",
    rateLimitMbps: 0,
    bandwidthAggregationEnabled: true,
    bandwidthAggregationStrategy: "capacity",
    bandwidthAggregationSlots: 8,
    bandwidthAggregationMinMembers: 1,
    ...overrides,
  };
}

test("throughput is derived from consecutive host metric samples", () => {
  // 125 MB in 10 s across both directions = 100 Mbps.
  const rows = [
    snapshot(7, 0, { in: 100_000_000, out: 25_000_000 }),
    snapshot(7, 10_000, { in: 0, out: 0 }),
  ];
  const throughput = hostThroughputMbpsFromSnapshots(rows, NOW);
  assert.equal(throughput.get(7), 100);
});

test("a host with a single sample reports no throughput", () => {
  const throughput = hostThroughputMbpsFromSnapshots([snapshot(7, 0, { in: 10, out: 10 })], NOW);
  assert.equal(throughput.has(7), false);
});

test("stale samples are ignored so an offline host does not look busy", () => {
  const age = AGGREGATION_THROUGHPUT_SAMPLE_MAX_AGE_MS + 60_000;
  const rows = [
    snapshot(7, age, { in: 100_000_000, out: 0 }),
    snapshot(7, age + 10_000, { in: 0, out: 0 }),
  ];
  assert.equal(hostThroughputMbpsFromSnapshots(rows, NOW).has(7), false);
});

test("counter resets and unordered samples never produce negative rates", () => {
  const rows = [
    snapshot(7, 0, { in: 5_000, out: 5_000 }),
    snapshot(7, 10_000, { in: 900_000_000, out: 900_000_000 }),
  ];
  assert.equal(hostThroughputMbpsFromSnapshots(rows, NOW).get(7), 0);
});

test("aggregation settings normalize stored column values", () => {
  const settings = resolveAggregationSettings(aggregationGroup({
    bandwidthAggregationStrategy: "nonsense",
    bandwidthAggregationSlots: 999,
    bandwidthAggregationMinMembers: 0,
  }));
  assert.deepEqual(settings, {
    enabled: true,
    strategy: "capacity",
    recordSlots: 32,
    minHealthyMembers: 1,
  });
  assert.equal(resolveAggregationSettings({ bandwidthAggregationEnabled: 1 }).enabled, true);
  assert.equal(resolveAggregationSettings({ bandwidthAggregationEnabled: 0 }).enabled, false);
  assert.equal(resolveAggregationSettings({}).enabled, false);
});

test("only entry groups that opted in count as aggregation groups", () => {
  assert.equal(isBandwidthAggregationGroup(aggregationGroup()), true);
  assert.equal(isBandwidthAggregationGroup(aggregationGroup({ groupMode: "failover" })), false);
  assert.equal(isBandwidthAggregationGroup(aggregationGroup({ bandwidthAggregationEnabled: false })), false);
});

test("the group plan combines member capacity with live throughput", () => {
  const plan = buildEntryGroupAggregationPlan({
    group: aggregationGroup({ bandwidthAggregationStrategy: "adaptive" }),
    members: [
      { memberId: 11, hostId: 1, value: "1.1.1.1", healthy: true, bandwidthMbps: 500 },
      { memberId: 12, hostId: 2, value: "2.2.2.2", healthy: true, bandwidthMbps: 500 },
    ],
    throughputByHostId: new Map([[1, 450], [2, 50]]),
  });

  const byId = new Map(plan.members.map((entry) => [entry.memberId, entry]));
  assert.equal(plan.aggregateCapacityMbps, 1000);
  assert.equal(plan.aggregateUsedMbps, 500);
  assert.ok(byId.get(12)!.share > byId.get(11)!.share, "the idle front VPS takes the larger share");
});

test("a disabled group still reports capacity but splits slots evenly", () => {
  const plan = buildEntryGroupAggregationPlan({
    group: aggregationGroup({ bandwidthAggregationEnabled: false }),
    members: [
      { memberId: 11, hostId: 1, value: "1.1.1.1", healthy: true, bandwidthMbps: 900 },
      { memberId: 12, hostId: 2, value: "2.2.2.2", healthy: true, bandwidthMbps: 100 },
    ],
  });
  assert.equal(plan.enabled, false);
  assert.deepEqual(plan.members.map((entry) => entry.recordSlots), [4, 4]);
});

test("DDNS values are ranked by share and never repeat a record value", () => {
  const plan = buildEntryGroupAggregationPlan({
    group: aggregationGroup({ bandwidthAggregationSlots: 4 }),
    members: [
      { memberId: 11, hostId: 1, value: "1.1.1.1", healthy: true, bandwidthMbps: 100 },
      { memberId: 12, hostId: 2, value: "2.2.2.2", healthy: true, bandwidthMbps: 1000 },
    ],
  });
  const result = applyAggregationToDdnsValues(plan, ["1.1.1.1", "2.2.2.2"]);

  assert.equal(result.applied, true);
  assert.deepEqual(result.values, ["2.2.2.2", "1.1.1.1"], "the larger front VPS is offered first");
  assert.equal(new Set(result.values).size, result.values.length, "a record value never repeats");
  assert.match(result.note, /带宽聚合已生效/);
});

test("an unranked healthy value keeps its record", () => {
  const plan = buildEntryGroupAggregationPlan({
    group: aggregationGroup(),
    members: [{ memberId: 11, hostId: 1, value: "1.1.1.1", healthy: true, bandwidthMbps: 100 }],
  });
  const result = applyAggregationToDdnsValues(plan, ["9.9.9.9", "1.1.1.1"]);
  assert.deepEqual(result.values, ["1.1.1.1", "9.9.9.9"]);
});

test("an order that already matches the plan is reported as a no-op", () => {
  const plan = buildEntryGroupAggregationPlan({
    group: aggregationGroup(),
    members: [
      { memberId: 11, hostId: 1, value: "1.1.1.1", healthy: true, bandwidthMbps: 1000 },
      { memberId: 12, hostId: 2, value: "2.2.2.2", healthy: true, bandwidthMbps: 100 },
    ],
  });
  const result = applyAggregationToDdnsValues(plan, ["1.1.1.1", "2.2.2.2"]);
  assert.equal(result.applied, false);
  assert.deepEqual(result.values, ["1.1.1.1", "2.2.2.2"]);
});

test("a member the caller already excluded is not reintroduced", () => {
  const plan = buildEntryGroupAggregationPlan({
    group: aggregationGroup(),
    members: [
      { memberId: 11, hostId: 1, value: "1.1.1.1", healthy: true, bandwidthMbps: 500 },
      { memberId: 12, hostId: 2, value: "2.2.2.2", healthy: true, bandwidthMbps: 500 },
    ],
  });
  const result = applyAggregationToDdnsValues(plan, ["1.1.1.1"]);
  assert.deepEqual(new Set(result.values), new Set(["1.1.1.1"]));
});

test("a degraded or disabled plan leaves the published values untouched", () => {
  const degraded = buildEntryGroupAggregationPlan({
    group: aggregationGroup({ bandwidthAggregationMinMembers: 3 }),
    members: [
      { memberId: 11, hostId: 1, value: "1.1.1.1", healthy: true, bandwidthMbps: 900 },
      { memberId: 12, hostId: 2, value: "2.2.2.2", healthy: true, bandwidthMbps: 100 },
    ],
  });
  const result = applyAggregationToDdnsValues(degraded, ["1.1.1.1", "2.2.2.2"]);
  assert.equal(result.applied, false);
  assert.deepEqual(result.values, ["1.1.1.1", "2.2.2.2"]);

  const off = buildEntryGroupAggregationPlan({
    group: aggregationGroup({ bandwidthAggregationEnabled: false }),
    members: [{ memberId: 11, hostId: 1, value: "1.1.1.1", healthy: true, bandwidthMbps: 900 }],
  });
  assert.equal(applyAggregationToDdnsValues(off, ["1.1.1.1"]).applied, false);
});

test("an empty published set is returned unchanged", () => {
  const plan = buildEntryGroupAggregationPlan({ group: aggregationGroup(), members: [] });
  const result = applyAggregationToDdnsValues(plan, []);
  assert.equal(result.applied, false);
  assert.deepEqual(result.values, []);
});

test("the summary carries settings, capacity and per-member rows", () => {
  const group = aggregationGroup({ rateLimitMbps: 600 });
  const plan = buildEntryGroupAggregationPlan({
    group,
    members: [
      { memberId: 11, hostId: 1, value: "1.1.1.1", healthy: true, bandwidthMbps: 400 },
      { memberId: 12, hostId: 2, value: "2.2.2.2", healthy: false, bandwidthMbps: 200 },
    ],
    throughputByHostId: new Map([[1, 100]]),
  });
  const summary = summarizeAggregationPlan(group, plan);

  assert.equal(summary.enabled, true);
  assert.equal(summary.strategy, "capacity");
  assert.equal(summary.healthyCount, 1);
  assert.equal(summary.memberCount, 2);
  assert.equal(summary.aggregateCapacityMbps, 400);
  assert.equal(summary.aggregateUsedMbps, 100);
  assert.equal(summary.aggregateAvailableMbps, 300);
  assert.equal(summary.members[0].rateLimitMbps, 600);
});
