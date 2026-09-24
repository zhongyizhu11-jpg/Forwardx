import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LedgerRow, ledgerMeta } from "./LedgerRow";

test("第二行只写有的那几项：空的、「-」、false 都不留「 ·  · 」", () => {
  assert.equal(ledgerMeta("DEV-ORDER-1004", "", null, undefined, "-", false, "已完成"), "DEV-ORDER-1004 · 已完成");
  assert.equal(ledgerMeta(), "");
});

test("一条流水：名称和金额在第一行，补充在第二行，金额的颜色由调用方给", () => {
  const html = renderToStaticMarkup(<LedgerRow title="流量计费" meta="已完成 · 9/22" amount="-¥13.00" amountClassName="text-destructive" />);
  assert.match(html, /fx-list-row/);
  assert.match(html, /流量计费[^]*已完成 · 9\/22[^]*text-destructive[^>]*>-¥13\.00/);
  assert.doesNotMatch(renderToStaticMarkup(<LedgerRow title="x" />), /tabular-nums/, "没有金额就不画那一格");
});
