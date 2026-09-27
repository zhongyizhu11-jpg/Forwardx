import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { FilterChips } from "./filter-chips";

test("筛选药丸：选中的那一枚是 fx-chip-on，数字跟在名字后面，没数出来就不画", () => {
  const html = renderToStaticMarkup(
    <FilterChips
      ariaLabel="分类"
      value="tunnel"
      onChange={() => {}}
      items={[
        { value: "all", label: "全部", count: 16 },
        { value: "tunnel", label: "隧道转发", count: 4 },
        { value: "group", label: "转发组", count: null },
      ]}
    />,
  );
  assert.match(html, /role="group" aria-label="分类"/);
  assert.equal((html.match(/class="fx-chip"/g) || []).length, 2);
  assert.match(html, /class="fx-chip fx-chip-on"[^>]*><span>隧道转发<\/span><span class="fx-chip-count">4<\/span>/);
  assert.match(html, /<span>转发组<\/span><\/button>/);
});
