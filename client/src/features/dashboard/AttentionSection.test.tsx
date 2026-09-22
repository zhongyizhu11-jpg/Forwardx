import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { emptyAttentionTotals, type DashboardAttention, type DashboardAttentionRow } from "@shared/dashboardAttention";

import { ATTENTION_VISIBLE_ROWS, AttentionSection } from "./AttentionSection";
import { attentionHref } from "./attentionLinks";

const noop = () => {};

function attention(rows: DashboardAttentionRow[], totals: Partial<DashboardAttention["totals"]> = {}): DashboardAttention {
  const merged = emptyAttentionTotals();
  for (const item of rows) merged[item.reason] += 1;
  return { rows, totals: { ...merged, ...totals } };
}

function textOf(html: string) {
  return html.replace(/<[^>]*>/g, "\u0000");
}

test("没有要处理的事时整块不出现 —— 顶上已经写了「运行正常」", () => {
  assert.equal(renderToStaticMarkup(<AttentionSection attention={attention([])} isAdmin onOpen={noop} />), "");
  assert.equal(renderToStaticMarkup(<AttentionSection attention={undefined} isAdmin onOpen={noop} />), "");
});

test("一行一件事：状态点、名字、原因，排序是根因在前", () => {
  const now = Date.now();
  const html = renderToStaticMarkup(
    <AttentionSection
      now={now}
      isAdmin
      onOpen={noop}
      attention={attention([
        { reason: "forward-stalled", id: 7, name: "Game forward", at: null, hostName: "US backup" },
        { reason: "host-offline", id: 3, name: "US backup", at: now - 18 * 60_000 },
      ])}
    />,
  );
  const text = textOf(html);
  assert.ok(text.indexOf("US backup") < text.indexOf("Game forward"), "掉线的机器排在它上面那条转发前面");
  assert.match(html, /主机掉线 · 最后在线 18 分钟前/);
  assert.match(html, /role="img" aria-label="故障"/, "状态点和各页的点是同一套词汇");
  assert.match(html, /需要关注/);
});

test("截断之后脚注说清还有哪几类", () => {
  const rows: DashboardAttentionRow[] = Array.from({ length: ATTENTION_VISIBLE_ROWS + 2 }, (_, index) => ({
    reason: "forward-stalled",
    id: index + 1,
    name: `转发 ${index + 1}`,
    at: null,
  }));
  const html = renderToStaticMarkup(
    <AttentionSection isAdmin onOpen={noop} attention={attention(rows, { "forward-stalled": 9 })} />,
  );
  assert.equal((html.match(/fx-list-row /g) || []).length, ATTENTION_VISIBLE_ROWS);
  assert.match(html, /还有 4 条转发/, "总数是 9、画了 5 行 —— 按总数算，不按服务端带回来的行数算");
});

test("租户的隧道和转发组行不给链接，也就不画箭头", () => {
  const row: DashboardAttentionRow = { reason: "group-degraded", id: 1, name: "Media failover", at: null, groupMode: "failover" };
  const tenant = renderToStaticMarkup(<AttentionSection isAdmin={false} onOpen={noop} attention={attention([row])} />);
  assert.doesNotMatch(tenant, /lucide-chevron-right/, "一个点下去必然被弹回首页的入口比没有更糟");
  const admin = renderToStaticMarkup(<AttentionSection isAdmin onOpen={noop} attention={attention([row])} />);
  assert.match(admin, /lucide-chevron-right/);
});

test("转发组按形态落到链路页对应的 tab", () => {
  const base = { reason: "group-down" as const, id: 1, name: "g", at: null };
  assert.equal(attentionHref({ ...base, groupMode: "chain" }, { isAdmin: true }), "/tunnels?tab=chains");
  assert.equal(attentionHref({ ...base, groupMode: "exit" }, { isAdmin: true }), "/tunnels?tab=exits");
  assert.equal(attentionHref({ ...base, groupMode: "failover" }, { isAdmin: true }), "/tunnels?tab=groups");
  assert.equal(attentionHref({ ...base, groupMode: null }, { isAdmin: true }), "/tunnels?tab=groups");
  assert.equal(attentionHref({ ...base, groupMode: "chain" }, { isAdmin: false }), null);
});

test("暂停那一行给的是出路：续期、充值；管理员手动停的没有自助出路", () => {
  const paused = (pauseReason: string | null) => attentionHref(
    { reason: "forward-paused", id: 1, name: "", at: null, count: 2, pauseReason },
    { isAdmin: false },
  );
  assert.equal(paused("expired"), "/subscriptions");
  assert.equal(paused("traffic_limit"), "/subscriptions");
  assert.equal(paused("traffic_billing_balance"), "/wallet");
  assert.equal(paused("manual"), null);
  assert.equal(paused(null), null);
});
