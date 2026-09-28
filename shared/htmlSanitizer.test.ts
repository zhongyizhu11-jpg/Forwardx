import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeHtml } from "./htmlSanitizer";

const bypasses = [
  "<<x>img src=x onerror=alert(1)>",
  "<<<x>x>img src=x onerror=alert(1)>",
  "<scr<script>x</script>ipt>alert(1)</script>",
  "<<svg>svg onload=alert(1)>",
  "<!--<p>--><img src=x onerror=alert(1)>",
  "<a href=\"javascript:alert(1)\">x</a>",
  "<a href=\"jav&#x0a;ascript:alert(1)\">x</a>",
  "<p onclick=\"alert(1)\">x</p>",
];

test("删掉一个标签后左右文字拼不出新标签（嵌套绕过）", () => {
  for (const input of bypasses) {
    for (const output of [sanitizeHtml(input), sanitizeHtml(sanitizeHtml(input))]) {
      assert.doesNotMatch(output, /<(?!\/?(?:a|b|blockquote|br|code|del|div|em|h[1-6]|hr|i|li|ol|p|pre|span|strong|table|tbody|td|th|thead|tr|u|ul)[\s>])/i, `${input} → ${output}`);
      // 转义成文字的 `&lt;img onerror=…>` 无害，只看真正的标签里有没有事件属性、危险链接。
      for (const tag of output.match(/<[^>]*>/g) || []) {
        assert.doesNotMatch(tag, /\son[a-z]+\s*=/i, `${input} → ${output}`);
        assert.doesNotMatch(tag, /javascript:/i, `${input} → ${output}`);
      }
    }
  }
});

test("正常内容原样保留，孤立的 < 变成文字", () => {
  assert.equal(sanitizeHtml("<p>hi <b>x</b></p>"), "<p>hi <b>x</b></p>");
  assert.equal(sanitizeHtml("1 < 2"), "1 &lt; 2");
  assert.equal(
    sanitizeHtml("<a href=\"https://example.com\">x</a>"),
    "<a href=\"https://example.com\" target=\"_blank\" rel=\"noopener noreferrer\">x</a>",
  );
});
