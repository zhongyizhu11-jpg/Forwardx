import assert from "node:assert/strict";
import test from "node:test";

import {
  ATTENTION_REASONS,
  countAttentionDegraded,
  countAttentionIssues,
  describeAttentionRow,
  emptyAttentionTotals,
  formatAgo,
  sortAttentionRows,
  summarizeHiddenAttention,
  type DashboardAttentionRow,
} from "./dashboardAttention";
import { describeNetworkHealth, rollUpNetworkHealth } from "./networkHealth";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function row(reason: DashboardAttentionRow["reason"], id: number, extra: Partial<DashboardAttentionRow> = {}): DashboardAttentionRow {
  return { reason, id, name: `${reason}-${id}`, at: null, ...extra };
}

test("「需要关注」里的每一类都真的需要关注 —— 和状态词汇表说的是同一件事", () => {
  for (const [reason, spec] of Object.entries(ATTENTION_REASONS)) {
    assert.equal(
      describeNetworkHealth(spec.health).needsAttention,
      true,
      `${reason} 的状态是 ${spec.health}，词汇表说它不需要关注 —— 那它就不该出现在这个列表里`,
    );
  }
});

test("先按状态排，同一档里主机在前：根因先于症状", () => {
  const sorted = sortAttentionRows([
    row("forward-stalled", 1),
    row("host-never-connected", 2),
    row("group-degraded", 3),
    row("tunnel-stopped", 4),
    row("host-offline", 5),
    row("group-down", 6),
  ]);
  assert.deepEqual(
    sorted.map((item) => item.reason),
    ["host-offline", "tunnel-stopped", "group-down", "forward-stalled", "group-degraded", "host-never-connected"],
    "一台机器掉了，挂在它上面的隧道和转发会一起报；机器排最前，人第一眼看到的是根因",
  );
});

test("排在第一行的状态就是汇总出来的状态", () => {
  // 列表第一行和顶上的汇总各用各的顺序的话，迟早一个说红一个说黄。
  const rows = [row("group-degraded", 1), row("host-never-connected", 2), row("forward-stalled", 3)];
  const first = sortAttentionRows(rows)[0];
  assert.equal(
    ATTENTION_REASONS[first.reason].health,
    rollUpNetworkHealth(rows.map((item) => ATTENTION_REASONS[item.reason].health)),
  );
});

test("同一类里最近出事的在前，没有时间线索的沉底", () => {
  const now = Date.now();
  const sorted = sortAttentionRows([
    row("host-offline", 1, { at: now - DAY }),
    row("host-offline", 2, { at: null }),
    row("host-offline", 3, { at: now - MINUTE }),
  ]);
  assert.deepEqual(sorted.map((item) => item.id), [3, 1, 2]);
});

test("「多久前」的精度跟着距离走", () => {
  assert.equal(formatAgo(0), "刚刚");
  assert.equal(formatAgo(59 * 1000), "刚刚");
  assert.equal(formatAgo(MINUTE), "1 分钟前");
  assert.equal(formatAgo(59 * MINUTE), "59 分钟前");
  assert.equal(formatAgo(HOUR), "1 小时前");
  assert.equal(formatAgo(23 * HOUR + 59 * MINUTE), "23 小时前");
  assert.equal(formatAgo(DAY), "1 天前");
  assert.equal(formatAgo(5 * DAY + 17 * HOUR), "5 天前", "几天前的事精确到天就够了，后面那截没人读");
  assert.equal(formatAgo(-2 * MINUTE), "刚刚", "时钟有一点偏差时不写「-2 分钟前」");
  assert.equal(formatAgo(Number.NaN), "");
});

test("每一行说出了什么事，再给一条下一步最有用的线索", () => {
  const now = Date.now();
  assert.deepEqual(
    describeAttentionRow(row("host-offline", 1, { name: "US backup", at: now - 18 * MINUTE }), now),
    { title: "US backup", detail: "主机掉线 · 最后在线 18 分钟前" },
  );
  assert.equal(
    describeAttentionRow(row("tunnel-stopped", 2, { entryName: "SG relay", exitName: "US backup" }), now).detail,
    "隧道没在运行 · SG relay → US backup",
  );
  assert.equal(
    describeAttentionRow(row("group-degraded", 3, { message: "备线离线" }), now).detail,
    "转发组降级 · 备线离线",
  );
  assert.equal(
    describeAttentionRow(row("forward-stalled", 4, { hostName: "HK entry" }), now).detail,
    "转发没在运行 · 在 HK entry 上",
  );
  assert.equal(
    describeAttentionRow(row("forward-stalled", 5, { groupName: "API 主备", hostName: "HK entry" }), now).detail,
    "转发没在运行 · API 主备 里没有一台在跑",
    "模板规则不跑，说它在哪台机器上是误导 —— 说它属于哪个转发组",
  );
  assert.equal(
    describeAttentionRow(row("host-offline", 6, { at: null }), now).detail,
    "主机掉线",
    "没有时间线索就不编一个",
  );
});

test("暂停那一行：标题就是出了什么事，下面说原因也说出路", () => {
  const described = describeAttentionRow(row("forward-paused", 1, { name: "", count: 3, pauseReason: "expired" }));
  assert.equal(described.title, "转发已暂停");
  assert.equal(
    described.detail,
    "账户到期了，续期后自动恢复 · 3 条转发停着",
    "原因和出路在前：窄屏上截断时先丢的应该是条数，不是出路",
  );
  assert.match(
    describeAttentionRow(row("forward-paused", 1, { name: "", count: 1, pauseReason: "traffic_billing_balance" })).detail,
    /充值/,
  );
  assert.match(
    describeAttentionRow(row("forward-paused", 1, { name: "", count: 1, pauseReason: null })).detail,
    /联系管理员/,
    "拿不到原因时不硬编一个",
  );
});

test("顶上的异常数只数 down；降级另算；还没接入两边都不算", () => {
  const totals = emptyAttentionTotals();
  totals["host-offline"] = 1;
  totals["host-never-connected"] = 4;
  totals["tunnel-stopped"] = 2;
  totals["group-down"] = 1;
  totals["group-degraded"] = 3;
  totals["forward-stalled"] = 5;
  totals["forward-paused"] = 1;
  assert.equal(countAttentionIssues(totals), 1 + 2 + 1 + 5 + 1);
  assert.equal(countAttentionDegraded(totals), 3);
  assert.equal(countAttentionIssues(null), 0);
});

test("截断之后说清还有哪几类，而不只是一个总数", () => {
  const totals = emptyAttentionTotals();
  totals["host-offline"] = 1;
  totals["group-down"] = 1;
  totals["group-degraded"] = 1;
  totals["forward-stalled"] = 3;
  const shown = [row("host-offline", 1), row("forward-stalled", 2)];
  assert.equal(summarizeHiddenAttention(totals, shown), "还有 2 个转发组、2 条转发");
  assert.equal(summarizeHiddenAttention(totals, [
    row("host-offline", 1), row("group-down", 2), row("group-degraded", 3),
    row("forward-stalled", 4), row("forward-stalled", 5), row("forward-stalled", 6),
  ]), null, "全画出来了就不要再补一句");
});
