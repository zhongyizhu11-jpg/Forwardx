import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 开关和复选框的分工，手册定得很死：
 *
 *   Switch   用于「切换后**立即生效**、无需提交」
 *   Checkbox 用于「改完要**点保存**才算数」
 *
 * 这不是外观偏好。一个亮着的开关在用户眼里就是「已经生效了」；如果它其实要
 * 等点保存，那它一直在说谎 —— 关掉对话框改动就没了，界面上看不出来。
 * 这正是这个项目反复出现的那类毛病：A 变了，B 没跟上，而界面上看不出来。
 *
 * 判定看 `onCheckedChange` 里干了什么：
 *   - 调 `.mutate()` / `mutateAsync` / `onCheckedChangeAsync`  → 立即生效
 *   - 调 `setXxx(...)` / `setForm(...)` / `updateXxx(...)`      → 写进本地草稿，要提交
 *
 * 两种特征都没有的（比如 `disabled checked={false}` 那种「当前协议不支持」的
 * 占位，或者把回调当 prop 透传的包装组件）判不了，放过 —— 宁可漏不可误杀。
 */

const ROOT = path.resolve(import.meta.dirname);

function collectTsx(dir: string, out: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTsx(full, out);
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** 属性区到哪结束：括号和引号要跟着数，否则 className={cn("a>b")} 里的 > 会骗过去。 */
function tagEnd(source: string, index: number) {
  let depth = 0;
  let i = index;
  while (i < source.length) {
    const c = source[i];
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") i += 1;
        i += 1;
      }
    } else if (c === ">" && depth === 0) return i;
    i += 1;
  }
  return -1;
}

const IMMEDIATE = /\.mutate\(|mutateAsync|onCheckedChangeAsync/;
const DEFERRED = /set[A-Z]\w*\(|setForm\(|onCheckedChange=\{set[A-Z]|update[A-Z]\w*\(/;

function scan(source: string, relative: string) {
  const usesSwitch = /from\s+["'][^"']*\/components\/ui\/switch["']/.test(source);
  const found: { loc: string; tag: string; kind: "immediate" | "deferred" | "unknown" }[] = [];
  const tags = /<(Switch|OptimisticSwitch|Checkbox)[\s/>]/g;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(source))) {
    const tag = match[1];
    // wouter 的路由组件也叫 <Switch>，只认从 ui/switch 导入的那个
    if (tag !== "Checkbox" && !usesSwitch) continue;
    const end = tagEnd(source, match.index + match[0].length - 1);
    if (end < 0) continue;
    const attrs = source.slice(match.index + match[0].length - 1, end);
    const immediate = IMMEDIATE.test(attrs);
    const deferred = DEFERRED.test(attrs);
    found.push({
      loc: `${relative}:${source.slice(0, match.index).split("\n").length}`,
      tag,
      kind: immediate && !deferred ? "immediate" : deferred && !immediate ? "deferred" : "unknown",
    });
  }
  return found;
}

test("要点保存的不用 Switch，立即生效的不用 Checkbox", () => {
  const 开关却要提交: string[] = [];
  const 复选框却立即生效: string[] = [];
  let total = 0;
  for (const file of collectTsx(ROOT)) {
    const relative = path.relative(ROOT, file);
    if (relative.startsWith(path.join("components", "ui") + path.sep)) continue;
    for (const item of scan(fs.readFileSync(file, "utf8"), relative)) {
      total += 1;
      if (item.tag !== "Checkbox" && item.kind === "deferred") 开关却要提交.push(item.loc);
      if (item.tag === "Checkbox" && item.kind === "immediate") 复选框却立即生效.push(item.loc);
    }
  }
  assert.ok(total >= 120, `只扫到 ${total} 个开关/复选框，扫描逻辑可能失效了`);
  assert.deepEqual(
    开关却要提交,
    [],
    `这些开关改完要点保存，按手册该用 Checkbox —— 亮着的开关会让人以为已经生效：\n  ${开关却要提交.join("\n  ")}`,
  );
  assert.deepEqual(
    复选框却立即生效,
    [],
    `这些复选框是点一下就生效的，按手册该用 Switch：\n  ${复选框却立即生效.join("\n  ")}`,
  );
});

test("判定逻辑本身", () => {
  const immediate = scan('import x from "@/components/ui/switch";\n<Switch checked={a} onCheckedChange={(v) => toggle.mutate(v)} />', "a.tsx");
  assert.equal(immediate[0].kind, "immediate");

  const deferred = scan('import x from "@/components/ui/switch";\n<Switch checked={a} onCheckedChange={(v) => setForm({ ...form, a: v })} />', "b.tsx");
  assert.equal(deferred[0].kind, "deferred");

  const unknown = scan('import x from "@/components/ui/switch";\n<Switch checked={false} disabled aria-label="当前协议不支持" />', "c.tsx");
  assert.equal(unknown[0].kind, "unknown", "判不了的要放过，不能误杀");

  // wouter 的路由不算开关
  assert.equal(scan('<Switch><Route path="/" /></Switch>', "d.tsx").length, 0);
});
