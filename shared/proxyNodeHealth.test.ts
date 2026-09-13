import assert from "node:assert/strict";
import test from "node:test";

import { LINK_PROBE_FRESH_MS, LINK_PROBE_MAX_FUTURE_SKEW_MS } from "./linkProbePolicy";
import {
  isProbeFresh,
  resolveProxyNodeHealth,
  PROXY_NODE_TRAFFIC_WINDOW_HOURS,
  type ProxyNodeProbeSample,
  summarizeProxyNodeHealthCounts,
} from "./proxyNodeHealth";

const NOW = 1_700_000_000_000;

function sample(over: Partial<ProxyNodeProbeSample> = {}): ProxyNodeProbeSample {
  return { latencyMs: 23, isTimeout: false, at: NOW - 10_000, ...over };
}

test("没有任何探测时是未知，不是离线", () => {
  // 关键：没绑转发的节点没人探它。标成离线会把一个好节点冤枉成故障，
  // 用户会去排查一个根本不存在的问题。
  const health = resolveProxyNodeHealth([], NOW);
  assert.equal(health.state, "unknown");
  assert.equal(health.latencyMs, null);
});

test("新鲜且可达是在线，并给出延迟", () => {
  const health = resolveProxyNodeHealth([sample({ latencyMs: 42 })], NOW);
  assert.equal(health.state, "online");
  assert.equal(health.latencyMs, 42);
  assert.match(health.title, /42ms/);
});

test("新鲜且超时是离线", () => {
  const health = resolveProxyNodeHealth([sample({ latencyMs: null, isTimeout: true })], NOW);
  assert.equal(health.state, "offline");
  assert.equal(health.latencyMs, null);
});

test("任一中转探得通就算在线", () => {
  /**
   * 同一个落地被多台中转指向时，一台连不上是那条线路的问题，不是落地的问题。
   * 按「全部可达才算在线」判的话，任意一个机房抖一下都会把落地误标成挂了。
   */
  const health = resolveProxyNodeHealth([
    sample({ latencyMs: null, isTimeout: true }),
    sample({ latencyMs: 88 }),
    sample({ latencyMs: null, isTimeout: true }),
  ], NOW);
  assert.equal(health.state, "online");
  // 取最快的那条，并说明还有几条不通。
  assert.equal(health.latencyMs, 88);
  assert.match(health.title, /2 条中转探测超时/);
});

test("多条中转全部超时才算离线", () => {
  const health = resolveProxyNodeHealth([
    sample({ latencyMs: null, isTimeout: true }),
    sample({ latencyMs: null, isTimeout: true }),
  ], NOW);
  assert.equal(health.state, "offline");
  assert.match(health.title, /2 条中转探测均超时/);
});

test("多条可达时取最快的那条", () => {
  const health = resolveProxyNodeHealth([
    sample({ latencyMs: 300 }),
    sample({ latencyMs: 12 }),
    sample({ latencyMs: 90 }),
  ], NOW);
  assert.equal(health.latencyMs, 12);
  // 全通的时候不该多出一句「N 条超时」。
  assert.doesNotMatch(health.title, /超时/);
});

test("过期的探测不算数，退回未知", () => {
  // 半小时前通不等于现在通。拿旧结果点绿灯，等于告诉用户一切正常。
  const stale = resolveProxyNodeHealth([sample({ at: NOW - LINK_PROBE_FRESH_MS - 1 })], NOW);
  assert.equal(stale.state, "unknown");

  const justInside = resolveProxyNodeHealth([sample({ at: NOW - LINK_PROBE_FRESH_MS + 1 })], NOW);
  assert.equal(justInside.state, "online");
});

test("过期的超时同样退回未知，而不是一直红着", () => {
  // 否则一条早就删掉的旧探测会让节点永远挂着红灯。
  const health = resolveProxyNodeHealth(
    [sample({ latencyMs: null, isTimeout: true, at: NOW - LINK_PROBE_FRESH_MS - 1 })],
    NOW,
  );
  assert.equal(health.state, "unknown");
});

test("时钟略微超前的探测仍然算数，离谱的不算", () => {
  // 中转机和面板的时钟不会完全一致，容忍一点点超前；
  // 但一个几小时之后的时间戳是坏数据，不能拿它点灯。
  assert.equal(isProbeFresh(NOW + LINK_PROBE_MAX_FUTURE_SKEW_MS - 1, NOW), true);
  assert.equal(isProbeFresh(NOW + LINK_PROBE_MAX_FUTURE_SKEW_MS + 1, NOW), false);
});

test("没有时间戳的探测一律不算数", () => {
  assert.equal(isProbeFresh(0, NOW), false);
  assert.equal(isProbeFresh(Number.NaN, NOW), false);
  assert.equal(resolveProxyNodeHealth([sample({ at: 0 })], NOW).state, "unknown");
});

test("可达但延迟字段缺失时按不可达处理", () => {
  // isTimeout 是 false 而 latencyMs 是 null，是一条自相矛盾的记录。
  // 当成在线会显示出一个没有数字的绿灯，当成超时至少是保守的。
  const health = resolveProxyNodeHealth([sample({ latencyMs: null, isTimeout: false })], NOW);
  assert.equal(health.state, "offline");
});

test("流量窗口不超过 traffic_stats 的保留期", async () => {
  /**
   * traffic_stats 过了保留期就被清掉。窗口比保留期长的话，界面上的数字会按实际
   * 存下来的那点数据悄悄偏小，而标签还写着一个更长的时间范围 —— 那是一句假话。
   *
   * 所以这里直接跟真正的保留期比，而不是各写一个 72：改保留期的人会在这里被拦下。
   */
  const { TRAFFIC_BUCKET_RETENTION_HOURS } = await import("../server/repositories/metricsRepository");
  assert.ok(
    PROXY_NODE_TRAFFIC_WINDOW_HOURS <= TRAFFIC_BUCKET_RETENTION_HOURS,
    `流量窗口 ${PROXY_NODE_TRAFFIC_WINDOW_HOURS}h 超过了保留期 ${TRAFFIC_BUCKET_RETENTION_HOURS}h`,
  );
});

/**
 * 「没探测过」不是「在线」。判错的后果是页面在一个还没连通的面板上写「节点全在线」。
 */

test("刚建好还没探测：不说在线，也不说离线", () => {
  const summary = summarizeProxyNodeHealthCounts({ total: 9, online: 0, offline: 0 });
  assert.equal(summary.badge, null, "不知道就别出徽标");
  assert.equal(summary.subtitle, "9 待探测");
  assert.equal(summary.unknown, 9);
});

test("全部探测过且都通，才敢说全在线", () => {
  assert.deepEqual(
    summarizeProxyNodeHealthCounts({ total: 3, online: 3, offline: 0 }).badge,
    { text: "节点全在线", tone: "ok" },
  );
  // 还有一个没探测：不能说全在线。
  assert.equal(summarizeProxyNodeHealthCounts({ total: 3, online: 2, offline: 0 }).badge, null);
});

test("有离线的就直说几个离线", () => {
  const summary = summarizeProxyNodeHealthCounts({ total: 5, online: 3, offline: 1 });
  assert.deepEqual(summary.badge, { text: "1 个节点离线", tone: "warn" });
  assert.equal(summary.subtitle, "3 在线 · 1 离线 · 1 待探测");
});

test("一个节点都没有的时候不谈在线", () => {
  const summary = summarizeProxyNodeHealthCounts({ total: 0, online: 0, offline: 0 });
  assert.equal(summary.badge, null);
  assert.equal(summary.subtitle, "还没有节点");
});

test("数对不上时不写出负数", () => {
  const summary = summarizeProxyNodeHealthCounts({ total: 2, online: 5, offline: 3 });
  assert.equal(summary.unknown, 0);
});
