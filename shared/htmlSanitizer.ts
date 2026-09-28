const ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

const VOID_TAGS = new Set(["br", "hr"]);
const ALLOWED_ATTRS = new Set(["class", "href", "rel", "target", "title"]);
const URL_ATTRS = new Set(["href"]);

export function escapeHtml(content: string) {
  return String(content || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decodeBasicEntities(value: string) {
  return String(value || "")
    .replace(/&colon;/gi, ":")
    .replace(/&#0*58;/gi, ":")
    .replace(/&#x0*3a;/gi, ":")
    .replace(/&tab;/gi, "\t")
    .replace(/&#0*9;/gi, "\t")
    .replace(/&#x0*9;/gi, "\t")
    .replace(/&newline;/gi, "\n")
    .replace(/&#0*10;/gi, "\n")
    .replace(/&#x0*a;/gi, "\n")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'");
}

function isSafeUrl(value: string) {
  const normalized = decodeBasicEntities(value).replace(/[\u0000-\u001f\u007f\s]+/g, "").trim();
  return /^(https?:|mailto:|tel:|\/|#)/i.test(normalized);
}

function sanitizeAttributes(rawAttrs: string, tagName: string) {
  const attrs: string[] = [];
  const attrPattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(rawAttrs))) {
    const name = match[1].toLowerCase();
    if (name.startsWith("on") || !ALLOWED_ATTRS.has(name)) continue;
    if ((name === "class" && tagName !== "code") || (name === "target" && tagName !== "a") || (name === "rel" && tagName !== "a")) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (URL_ATTRS.has(name) && !isSafeUrl(value)) continue;
    const safeValue = escapeHtml(value).replace(/\r?\n/g, " ");
    attrs.push(`${name}="${safeValue}"`);
  }
  if (tagName === "a") {
    const hasTarget = attrs.some((attr) => attr.startsWith("target="));
    const hasRel = attrs.some((attr) => attr.startsWith("rel="));
    if (!hasTarget) attrs.push('target="_blank"');
    if (!hasRel) attrs.push('rel="noopener noreferrer"');
  }
  return attrs.length ? ` ${attrs.join(" ")}` : "";
}

// `<` 后面紧跟字母（或 `/` 加字母）浏览器才当标签；`a < b 且 c > d` 这种是正文。以前这里
// 允许 `<` 后带空格，服务端存纯文本公告时会把它改成 `a <b> d`，吞掉中间的字。
function sanitizeOnce(input: string) {
  const withoutDangerousBlocks = input
    .replace(/<(script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select|option|svg|math)[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<(script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select|option|svg|math)\b[^>]*\/?\s*>/gi, "");

  return withoutDangerousBlocks.replace(/<(\/)?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g, (full, closing: string, rawName: string, rawAttrs: string) => {
    const tagName = rawName.toLowerCase();
    if (!ALLOWED_TAGS.has(tagName)) return "";
    if (closing) return VOID_TAGS.has(tagName) ? "" : `</${tagName}>`;
    const attrs = sanitizeAttributes(rawAttrs || "", tagName);
    return VOID_TAGS.has(tagName) ? `<${tagName}${attrs}>` : `<${tagName}${attrs}>`;
  });
}

/*
  删掉一个标签，两边剩下的字会拼成一个新标签：`<<x>img src=x onerror=…>` 里 `<x>` 被删，
  剩下的正好是 `<img src=x onerror=…>`，而 replace 不会回头再扫刚拼出来的这段 —— 洗一遍
  就放行了一个能跑脚本的标签。服务端存公告时洗一遍、前端显示前再洗一遍也挡不住，多套一层
  `<<<x>x>` 就又多撑一遍。

  所以反复洗到结果不再变化为止：每套一层只多洗一遍，正常内容两遍就稳定（第二遍只是确认），
  输出和以前逐字相同。套得离谱、超过上限还在变的，整段按纯文本转义显示，不再冒险。
*/
const MAX_SANITIZE_PASSES = 16;

export function sanitizeHtml(input: string) {
  const original = String(input || "");
  let current = original;
  for (let pass = 0; pass < MAX_SANITIZE_PASSES; pass += 1) {
    const next = sanitizeOnce(current);
    if (next === current) return next;
    current = next;
  }
  return escapeHtml(original);
}
