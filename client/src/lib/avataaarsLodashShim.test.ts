import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { uniqueId } from "./avataaarsLodashShim";

/*
  vite.config.ts 把 avataaars 发出的 require("lodash") 换成了只有 uniqueId 的替身。
  哪天 avataaars 升级、多用了一个 lodash 函数，构建不会报错，要到运行时才
  「xxx is not a function」、头像整块出不来 —— 在这里先拦下。
*/

function jsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

test("avataaars 从 lodash 里只拿 uniqueId，替身够用", () => {
  const dist = path.join(process.cwd(), "node_modules/avataaars/dist");
  const used = new Set<string>();
  let requireCount = 0;
  for (const file of jsFiles(dist)) {
    const source = fs.readFileSync(file, "utf8");
    // 只认整包 require：require("lodash/xxx") 不经过替身，照常拿真 lodash，不在这里的约束内
    for (const [, binding] of source.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=\s*require\("lodash"\)/g)) {
      requireCount += 1;
      for (const [, member] of source.matchAll(new RegExp(`\\b${binding.replace(/\$/g, "\\$")}\\.([A-Za-z_$][\\w$]*)`, "g"))) {
        used.add(member);
      }
    }
    assert.doesNotMatch(source, /require\("lodash"\)(?!;)/, `${file} 以别的方式用了整包 lodash`);
  }
  assert.ok(requireCount > 0, "没找到 avataaars 对 lodash 的引用，替身插件可能已经多余");
  assert.deepEqual([...used].sort(), ["uniqueId"]);
});

test("替身和 lodash 一样：前缀加全局自增数字", () => {
  const first = uniqueId("react-path-");
  const second = uniqueId("react-path-");
  assert.match(first, /^react-path-\d+$/);
  assert.equal(Number(second.slice("react-path-".length)), Number(first.slice("react-path-".length)) + 1);
  assert.match(uniqueId(), /^\d+$/);
});

test("vite.config.ts 确实把替身接上了", () => {
  const config = fs.readFileSync(path.join(process.cwd(), "vite.config.ts"), "utf8");
  assert.match(config, /client\/src\/lib\/avataaarsLodashShim\.ts/);
  assert.match(config, /plugins:\s*\[avataaarsLodashShim\(\)/);
});
