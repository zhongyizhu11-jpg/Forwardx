import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/*
  package.json 里的 test:* 把测试文件一个个列出来。删掉或改名一个测试文件时很容易忘了
  这份名单，而 node --test 遇到列出来却不存在的文件会直接退出 —— 那条命令从此一个测试
  都不跑，只报 "Could not find ..."。pnpm test:all 是自己扫目录的，扫不出这个洞，所以
  这里替它守着：名单上的每个路径都得真的存在。
*/
const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

test("package.json 的测试脚本里列的文件都还在", () => {
  const missing: string[] = [];
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (!name.startsWith("test")) continue;
    for (const token of command.split(/\s+/)) {
      if (!/\.tsx?$/.test(token)) continue;
      if (!fs.existsSync(path.join(root, token))) missing.push(`${name}: ${token}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    "package.json 列了不存在的测试文件，这些命令会在跑任何测试之前就退出：\n" + missing.join("\n"),
  );
});
