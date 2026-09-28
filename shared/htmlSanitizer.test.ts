import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeHtml } from "./htmlSanitizer";

const ALLOWED = new Set([
  "a", "b", "blockquote", "br", "code", "del", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr",
  "i", "li", "ol", "p", "pre", "span", "strong", "table", "tbody", "td", "th", "thead", "tr", "u", "ul",
]);

/** 浏览器会当成标签的每一处 `<字母` / `</字母`，都必须是白名单里的标签，而且不带事件、不带 javascript: */
function assertOnlySafeMarkup(html: string, payload: string) {
  for (const match of html.matchAll(/<\/?([a-zA-Z][^\s/>]*)([^>]*)>?/g)) {
    assert.ok(ALLOWED.has(match[1].toLowerCase()), `「${payload}」洗完还剩 <${match[1]}>：${html}`);
    assert.doesNotMatch(match[2], /\bon[a-z]+\s*=/i, `「${payload}」洗完标签上还带事件：${html}`);
    assert.doesNotMatch(match[2], /javascript:/i, `「${payload}」洗完还有 javascript: 链接：${html}`);
  }
}

test("删掉一个标签拼出来的新标签，也会被洗掉", () => {
  const payloads = [
    "<<x>img src=x onerror=alert(1)>",
    "<<<x>x>img src=x onerror=alert(1)>",
    "<<<<x>x>x>svg onload=alert(1)>",
    "<<x>a href=\"javascript:alert(1)\">点我</a>",
    "<scr<script>x</script>ipt>alert(1)</script>",
    "<<script></script>img src=x onerror=alert(1)>",
    "<p>正常段落</p><<x>iframe src=\"https://evil.example\"></iframe>",
  ];
  for (const payload of payloads) {
    const once = sanitizeHtml(payload);
    assertOnlySafeMarkup(once, payload);
    // 服务端存之前洗一遍、前端显示前又洗一遍：第二遍不能再拼出东西
    assertOnlySafeMarkup(sanitizeHtml(once), payload);
  }
});

test("正常内容洗出来和以前一样，再洗一遍也不变", () => {
  const input = "<p>你好 <a href=\"https://example.com\">链接</a> <code class=\"lang-sh\">ls</code></p><br><hr>";
  const html = sanitizeHtml(input);
  assert.equal(
    html,
    "<p>你好 <a href=\"https://example.com\" target=\"_blank\" rel=\"noopener noreferrer\">链接</a> <code class=\"lang-sh\">ls</code></p><br><hr>",
  );
  assert.equal(sanitizeHtml(html), html);
});

test("纯文本和 Markdown 原样保存，一个字都不改", () => {
  // 服务端存公告时不管什么格式都洗一遍；`a < b 且 c > d` 以前会被存成 `a <b> d`
  for (const text of ["a < b 且 c > d", "> 引用一段话", "```\nif (a<b) {}\n```", "1 << 2", "x < y > z"]) {
    assert.equal(sanitizeHtml(text), text);
  }
});

test("套得离谱的内容整段当纯文本显示", () => {
  const payload = `${"<".repeat(40)}${"x>".repeat(40)}img src=x onerror=alert(1)>`;
  const html = sanitizeHtml(payload);
  assert.doesNotMatch(html, /</);
  assertOnlySafeMarkup(html, payload);
});
