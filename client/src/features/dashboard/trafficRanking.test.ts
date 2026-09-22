import assert from "node:assert/strict";
import test from "node:test";

import { formatShare, rankRuleTraffic } from "./trafficRanking";

const GB = 1024 ** 3;

test("三类合成一张排行：用户关心的是哪条转发最费流量，不是隧道里哪条最费", () => {
  const ranking = rankRuleTraffic({
    tunnelRules: [{ id: 1, name: "隧道 A", totalBytes: 3 * GB }],
    portRules: [{ id: 2, name: "端口 B", totalBytes: 8 * GB }, { id: 3, name: "端口 C", totalBytes: 1 * GB }],
    forwardGroupRules: [{ id: 4, name: "组 D", totalBytes: 5 * GB }],
  });
  assert.deepEqual(ranking.items.map((item) => item.name), ["端口 B", "组 D", "隧道 A", "端口 C"]);
  assert.deepEqual(ranking.items.map((item) => item.kind), ["port", "group", "tunnel", "port"]);
  assert.equal(ranking.totalBytes, 17 * GB);
});

test("条的长度相对第一名，占比相对全部", () => {
  const ranking = rankRuleTraffic({
    portRules: [{ id: 1, name: "a", totalBytes: 6 * GB }, { id: 2, name: "b", totalBytes: 3 * GB }, { id: 3, name: "c", totalBytes: 1 * GB }],
  });
  assert.equal(ranking.items[0].relative, 1, "第一名永远是满格");
  assert.equal(ranking.items[1].relative, 0.5);
  assert.equal(ranking.items[0].share, 0.6);
});

test("排不进前几名的说清几条、一共多少", () => {
  const ranking = rankRuleTraffic({
    portRules: Array.from({ length: 8 }, (_, index) => ({ id: index + 1, name: `r${index + 1}`, totalBytes: (index + 1) * GB })),
  }, 5);
  assert.equal(ranking.items.length, 5);
  assert.equal(ranking.restCount, 3);
  assert.equal(ranking.restBytes, (1 + 2 + 3) * GB);
});

test("0 字节的不上榜，拿不到数据时是空榜而不是报错", () => {
  const ranking = rankRuleTraffic({ tunnelRules: [{ id: 1, name: "idle", totalBytes: 0 }], portRules: null });
  assert.deepEqual(ranking.items, []);
  assert.equal(ranking.totalBytes, 0);
  assert.deepEqual(rankRuleTraffic(undefined).items, []);
});

test("小比例不写成 0%", () => {
  assert.equal(formatShare(0.254), "25%");
  assert.equal(formatShare(0.004), "0.4%");
  assert.equal(formatShare(0.0004), "<0.1%");
  assert.equal(formatShare(0), "0%");
});
