/**
 * Server side of 多前置 VPS 带宽叠加聚合 (multi-front-VPS bandwidth aggregation).
 *
 * The pure distribution math lives in `shared/bandwidthAggregation`. This module
 * adapts panel data to it: it turns raw host metric samples into a per-host
 * throughput figure, normalizes the aggregation columns stored on an entry
 * group, and assembles the plan the DDNS sync and the API both read.
 */

import {
  buildBandwidthAggregationPlan,
  normalizeAggregationMinMembers,
  normalizeAggregationRecordSlots,
  normalizeBandwidthAggregationStrategy,
  normalizeMemberBandwidthMbps,
  normalizeMemberWeight,
  type BandwidthAggregationPlan,
  type BandwidthAggregationStrategy,
} from "../shared/bandwidthAggregation";

/** Two consecutive host metric samples are needed to derive a rate. */
export type HostMetricSnapshot = {
  hostId: number;
  networkIn: number;
  networkOut: number;
  recordedAt: Date | string | number;
};

/**
 * Samples older than this are treated as no measurement at all, so a host that
 * stopped reporting does not keep an ancient throughput figure alive.
 */
export const AGGREGATION_THROUGHPUT_SAMPLE_MAX_AGE_MS = 5 * 60 * 1000;

function sampleTime(value: Date | string | number | null | undefined) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function nonNegative(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Derive the current uplink throughput of each host, in Mbps, from consecutive
 * `host_metrics` samples.
 *
 * Bandwidth aggregation cares about how much of a front VPS's uplink is already
 * committed, so inbound and outbound are combined into a single figure: a relay
 * carries every byte in both directions.
 */
export function hostThroughputMbpsFromSnapshots(
  snapshots: HostMetricSnapshot[],
  now = Date.now(),
) {
  const byHost = new Map<number, HostMetricSnapshot[]>();
  for (const snapshot of snapshots) {
    const hostId = Number(snapshot?.hostId || 0);
    if (!Number.isInteger(hostId) || hostId <= 0) continue;
    const bucket = byHost.get(hostId);
    if (bucket) bucket.push(snapshot);
    else byHost.set(hostId, [snapshot]);
  }

  const out = new Map<number, number>();
  for (const [hostId, bucket] of byHost) {
    const sorted = [...bucket].sort((left, right) => sampleTime(right.recordedAt) - sampleTime(left.recordedAt));
    const [latest, previous] = sorted;
    if (!latest || !previous) continue;
    const latestAt = sampleTime(latest.recordedAt);
    const previousAt = sampleTime(previous.recordedAt);
    if (latestAt <= 0 || previousAt <= 0 || latestAt <= previousAt) continue;
    if (now - latestAt > AGGREGATION_THROUGHPUT_SAMPLE_MAX_AGE_MS) continue;
    const elapsedSeconds = (latestAt - previousAt) / 1000;
    if (elapsedSeconds <= 0) continue;
    const deltaBytes = Math.max(0, nonNegative(latest.networkIn) - nonNegative(previous.networkIn))
      + Math.max(0, nonNegative(latest.networkOut) - nonNegative(previous.networkOut));
    const mbps = (deltaBytes * 8) / elapsedSeconds / 1_000_000;
    out.set(hostId, Math.max(0, Math.round(mbps)));
  }
  return out;
}

export type EntryGroupAggregationSettings = {
  enabled: boolean;
  strategy: BandwidthAggregationStrategy;
  recordSlots: number;
  minHealthyMembers: number;
};

/** Read the aggregation columns off a forward group row. */
export function resolveAggregationSettings(group: any): EntryGroupAggregationSettings {
  const raw = group?.bandwidthAggregationEnabled;
  const enabled = raw === true || raw === 1 || raw === "1" || String(raw).toLowerCase() === "true";
  return {
    enabled,
    strategy: normalizeBandwidthAggregationStrategy(group?.bandwidthAggregationStrategy),
    recordSlots: normalizeAggregationRecordSlots(group?.bandwidthAggregationSlots),
    minHealthyMembers: normalizeAggregationMinMembers(group?.bandwidthAggregationMinMembers),
  };
}

/** True only for entry groups that opted into bandwidth aggregation. */
export function isBandwidthAggregationGroup(group: any) {
  return String(group?.groupMode || "").trim().toLowerCase() === "entry"
    && resolveAggregationSettings(group).enabled;
}

export type AggregationMemberRow = {
  memberId: number;
  hostId: number;
  value: string;
  healthy: boolean;
  bandwidthMbps?: number | null;
  aggregationWeight?: number | null;
  label?: string | null;
};

export type EntryGroupAggregationInput = {
  group: any;
  members: AggregationMemberRow[];
  /** Live throughput per host id, in Mbps. */
  throughputByHostId?: Map<number, number> | null;
  /** CNAME records cannot repeat a value, so each member gets one slot. */
  singleValuePerMember?: boolean;
};

/**
 * Build the aggregation plan for one entry group from already loaded rows.
 *
 * Kept free of database access so both the DDNS sync path, which has the member
 * health it just computed, and the read-only API can share it.
 */
export function buildEntryGroupAggregationPlan(input: EntryGroupAggregationInput): BandwidthAggregationPlan {
  const settings = resolveAggregationSettings(input.group);
  const throughput = input.throughputByHostId || new Map<number, number>();
  return buildBandwidthAggregationPlan(
    input.members.map((member) => ({
      memberId: Number(member.memberId || 0),
      value: String(member.value || ""),
      label: member.label ?? null,
      healthy: member.healthy !== false,
      bandwidthMbps: normalizeMemberBandwidthMbps(member.bandwidthMbps),
      weight: normalizeMemberWeight(member.aggregationWeight),
      usedMbps: throughput.get(Number(member.hostId || 0)) ?? 0,
    })),
    {
      enabled: settings.enabled,
      strategy: settings.strategy,
      recordSlots: settings.recordSlots,
      minHealthyMembers: settings.minHealthyMembers,
      rateLimitMbps: Number(input.group?.rateLimitMbps || 0),
      singleValuePerMember: !!input.singleValuePerMember,
    },
  );
}

/**
 * Order the DDNS values an entry group is about to publish so the front VPS
 * with the largest share is offered to clients first.
 *
 * A DNS record set cannot carry the same value twice, so the slot weighting
 * cannot be expressed as repetition here. What it does express is order: the
 * interleaved slot list puts the highest-share member first and, once deduped,
 * ranks the rest by share. Resolvers that hand out records in order, and
 * clients that try them in order, then bias toward the members with the most
 * capacity. The per-member share also drives the rate-limit split, which is
 * where the aggregation is actually enforced on the agents.
 *
 * `values` is the healthy set the caller already decided on. Aggregation only
 * reorders those values, never which members count as healthy, so a member
 * excluded upstream stays excluded and every healthy member keeps a record.
 */
export function applyAggregationToDdnsValues(
  plan: BandwidthAggregationPlan,
  values: string[],
): { values: string[]; applied: boolean; note: string } {
  const allowed = new Set(values);
  if (!plan.enabled || plan.degraded || values.length === 0) {
    return { values, applied: false, note: plan.reason };
  }
  const ranked: string[] = [];
  const seen = new Set<string>();
  for (const value of plan.recordValues) {
    if (!allowed.has(value) || seen.has(value)) continue;
    seen.add(value);
    ranked.push(value);
  }
  if (ranked.length === 0) return { values, applied: false, note: plan.reason };

  // Anything the plan did not rank (a value with no matching member row) keeps
  // its record so no front VPS silently drops out of the entry domain.
  const ordered = [...ranked, ...values.filter((value) => !seen.has(value))];
  if (ordered.length === values.length && ordered.every((value, index) => value === values[index])) {
    return { values, applied: false, note: plan.reason };
  }
  const capacityNote = plan.aggregateCapacityMbps > 0
    ? `，聚合带宽约 ${plan.aggregateCapacityMbps} Mbps`
    : "";
  return {
    values: ordered,
    applied: true,
    note: `带宽聚合已生效：${plan.healthyCount} 台前置按${plan.strategy === "equal" ? "等量" : "权重"}排序解析${capacityNote}`,
  };
}

export type AggregationSummary = {
  enabled: boolean;
  strategy: BandwidthAggregationStrategy;
  recordSlots: number;
  minHealthyMembers: number;
  healthyCount: number;
  memberCount: number;
  aggregateCapacityMbps: number;
  aggregateUsedMbps: number;
  aggregateAvailableMbps: number;
  utilization: number;
  degraded: boolean;
  reason: string;
  members: BandwidthAggregationPlan["members"];
  recordValues: string[];
};

/** Shape the plan for the API and the panel UI. */
export function summarizeAggregationPlan(
  group: any,
  plan: BandwidthAggregationPlan,
): AggregationSummary {
  const settings = resolveAggregationSettings(group);
  return {
    enabled: settings.enabled,
    strategy: settings.strategy,
    recordSlots: settings.recordSlots,
    minHealthyMembers: settings.minHealthyMembers,
    healthyCount: plan.healthyCount,
    memberCount: plan.members.length,
    aggregateCapacityMbps: plan.aggregateCapacityMbps,
    aggregateUsedMbps: plan.aggregateUsedMbps,
    aggregateAvailableMbps: plan.aggregateAvailableMbps,
    utilization: plan.utilization,
    degraded: plan.degraded,
    reason: plan.reason,
    members: plan.members,
    recordValues: plan.recordValues,
  };
}
