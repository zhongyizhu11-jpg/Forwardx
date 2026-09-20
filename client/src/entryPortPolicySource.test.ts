import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 「这个端口允不允许」不许在界面这边重算一遍。
 *
 * 这套判定有三层叠加：主机自己的范围与白名单、隧道配的范围、以及非管理员的
 * 套餐端口段。前两层的合并还有个反直觉的特例 —— 隧道范围恰好等于主机范围时
 * 要保留主机的完整策略，直接求交会把主机白名单里那些额外端口吃掉。
 *
 * 界面以前就是自己算的，于是：
 *   · 提示文案少写了白名单端口和套餐端口段；
 *   · 判定超范围时**直接返回、连请求都不发**，用户被硬拦在一个服务端明明
 *     放行的端口上。
 *
 * 现在这份答案只从 rules.entryPortPolicy 拿。界面这边只保留两样：把空策略
 * 当占位（portPolicyFrom(null)），以及把策略渲染成文字（describePortPolicy）。
 * 任何**构造或合并**策略的函数都不该出现在这里 —— 它们一出现，就意味着又有
 * 一份会和服务端漂开的算法。
 */

const CONSTRUCTORS = [
  "combinePortPolicies",
  "combineHostPortPolicyWithRange",
  "isPortAllowedByPolicy",
  "portPolicyErrorMessage",
  "pickAvailablePort",
];

function walk(directory: string, out: string[] = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const clientRoot = path.resolve(import.meta.dirname);
const files = walk(clientRoot);

// 只看 import 语句，不扫全文 —— 否则解释「为什么不能用它」的注释本身就会
// 把用例弄红（第一版就是这么红的）。
function portPolicyImports(source: string) {
  const names: string[] = [];
  // 用 [^;]* 而不是 [\s\S]*?：后者会从文件的第一个 import 一路吃到这里，
  // 抽出来的名字全是垃圾，用例就空转了（第一版正是这么过的）。
  for (const match of source.matchAll(/import\s+([^;]*?)\s+from\s+["']@shared\/portPolicy["']/g)) {
    const clause = match[1];
    if (/^\s*\*/.test(clause)) return ["*"]; // 命名空间导入：等于把整包都拿进来了
    for (const piece of clause.replace(/[{}]/g, "").split(",")) {
      const name = piece.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

// 注释行里出现这些名字是正常的（就在解释为什么不能用），不该算数。
function withoutCommentLines(source: string) {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .join("\n");
}

test("界面不引入任何构造或合并端口策略的函数", () => {
  // 地板按实测值定（写这条时是 167），只用来发现「扫描范围塌了」，
  // 不是用来卡文件数量的。
  assert.ok(files.length > 120, `只扫到 ${files.length} 个文件，扫描范围恐怕塌了`);
  const offenders: string[] = [];
  let importers = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const imported = portPolicyImports(source);
    if (imported.length === 0) continue;
    importers++;
    for (const name of imported) {
      if (name === "*" || CONSTRUCTORS.includes(name)) {
        offenders.push(`${path.relative(clientRoot, file)} 引入了 ${name}`);
      }
    }
  }
  assert.ok(importers > 0, "一个引入 @shared/portPolicy 的界面文件都没扫到 —— 这条用例已经盯不住任何东西了");
  assert.deepEqual(
    offenders,
    [],
    "界面又开始自己算端口策略了：\n  " + offenders.join("\n  ")
      + "\n这份算法一定会和服务端漂开 —— 答案只能从 rules.entryPortPolicy 拿。",
  );
});

test("界面里 portPolicyFrom 只用来造空策略", () => {
  const calls: string[] = [];
  for (const file of files) {
    const source = withoutCommentLines(fs.readFileSync(file, "utf8"));
    for (const match of source.matchAll(/portPolicyFrom\(([^)]*)\)/g)) {
      const argument = match[1].trim();
      if (argument !== "null") {
        calls.push(`${path.relative(clientRoot, file)}: portPolicyFrom(${argument})`);
      }
    }
  }
  assert.deepEqual(
    calls,
    [],
    "portPolicyFrom 在界面这边只该用来占位（portPolicyFrom(null)）；"
      + "传主机或隧道进去，就是又照着算了一份：\n  " + calls.join("\n  "),
  );
});
