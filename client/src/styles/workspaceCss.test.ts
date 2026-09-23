import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * workspace.css 的两条底线（PR 8 清出来的）。
 *
 * 一、不按类名片段猜 DOM。`[class*="rounded-"][class*="border"]` 这种选择器会改掉任何
 *    碰巧同时写了这两个类的元素 —— 它误伤过 Entity 卡片的圆角，也按住过一个自己加了
 *    animate-pulse 的圆点。要改谁，就给谁一个明确的 fx-* 类名。
 *
 * 二、工作区卡片「不描边、不投影」要在任何宽度都成立。原来只写在手机那一段里，桌面上的
 *    Card 还带着边框和投影，和旁边的 EntityCard 一有框一没框。
 */
const css = fs.readFileSync(path.resolve(import.meta.dirname, "workspace.css"), "utf8");
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

test("不按类名片段猜 DOM", () => {
  assert.deepEqual(code.match(/\[class[*^$]=[^\]]*\]/g) ?? [], []);
  // 反向对照：注释里还写着那条被删掉的规则，确认上面确实是去掉注释之后才查的
  assert.match(css, /\[class\*="rounded-"\]\[class\*="border"\]/);
});

test("手机上不再给每个 <p> 加上下 12px", () => {
  assert.doesNotMatch(code, /\.workspace-main p\s*\{[^}]*margin/);
});

/** 最外层（不在任何 @media / @layer 里）的规则：按顶层花括号走，@ 开头的块整块跳过。 */
function topLevelRules(source: string) {
  const rules: { selector: string; body: string }[] = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf("{", i);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    while (j < source.length && depth > 0) {
      if (source[j] === "{") depth += 1;
      else if (source[j] === "}") depth -= 1;
      j += 1;
    }
    const selector = source.slice(i, open).trim();
    if (!selector.startsWith("@")) rules.push({ selector, body: source.slice(open + 1, j - 1) });
    i = j;
  }
  return rules;
}

test("工作区卡片不描边、不投影 —— 写在媒体查询外面，桌面也成立", () => {
  const rules = topLevelRules(code).filter((item) => item.selector === '.workspace-main [data-slot="card"]');
  assert.ok(rules.length > 0, "最外层有一条 .workspace-main [data-slot=\"card\"] 规则");
  const body = rules.map((item) => item.body).join(";");
  assert.match(body, /border:\s*0/);
  assert.match(body, /box-shadow:\s*none/);
});
