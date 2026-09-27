import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SummaryStrip } from "./SummaryStrip";

const render = (items: Parameters<typeof SummaryStrip>[0]["items"]) => renderToStaticMarkup(<SummaryStrip ariaLabel="概况" items={items} />);

test("几个数排成一行读数：四个也一行放下，不折成 2×2", () => {
  const four = render([1, 2, 3, 4].map((n) => ({ key: String(n), label: `数 ${n}`, value: n })));
  assert.match(four, /grid-cols-4/);
  const three = render([1, 2, 3].map((n) => ({ key: String(n), label: `数 ${n}`, value: n })));
  assert.match(three, /grid-cols-3/);
  assert.doesNotMatch(three, /grid-cols-2/);
  assert.match(four, /role="group" aria-label="概况"/);
  const one = render([{ key: "a", label: "余额", value: 1 }]);
  assert.match(one, /grid-cols-1/);
});

test("统计行不画框：外面只有上下两条线，格与格之间一条竖线，数字不用等宽字体", () => {
  const html = render([1, 2, 3].map((n) => ({ key: String(n), label: `数 ${n}`, value: n })));
  const [outer] = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]);
  assert.match(outer, /border-y/);
  assert.doesNotMatch(outer, /rounded|bg-\[/);
  assert.doesNotMatch(html, /font-mono/);
  assert.equal((html.match(/fx-summary-cell/g) || []).length, 3);
});

test("hintTone 只染补充那一行，数字保持黑色", () => {
  const html = render([{ key: "hosts", label: "主机", value: 4, hint: "3 在线", hintTone: "healthy" }]);
  assert.match(html, /style="color:var\(--fx-healthy-text, var\(--fx-healthy\)\)">3 在线/);
  assert.doesNotMatch(html, /style="color[^"]*"[^>]*>(?:<span[^>]*>)+4</);
});

test("能点的数是一个按钮，并且带一个箭头；不能点的不是按钮", () => {
  const html = render([
    { key: "pending", label: "待处理", value: 3, onClick: () => {} },
    { key: "nodes", label: "线路", value: 12 },
  ]);
  assert.equal((html.match(/<button/g) || []).length, 1);
  assert.match(html, /<button[^>]*>[^]*?待处理/);
  assert.equal((html.match(/aria-hidden="true"/g) || []).length, 1, "只有能点的那一格有箭头");
});

test("颜色只染数字，不染标签和补充那一行", () => {
  const html = render([{ key: "pending", label: "待处理", value: 3, hint: "3 条差节点", tone: "warn" }]);
  assert.match(html, /style="color:var\(--fx-warn-text, var\(--fx-warn\)\)">(?:<span[^>]*>)+3</);
  assert.doesNotMatch(html, /style="color[^"]*"[^>]*>待处理/);
});
