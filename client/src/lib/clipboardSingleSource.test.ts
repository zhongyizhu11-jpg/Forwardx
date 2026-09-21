import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 复制只许走 `lib/clipboard.ts`。
 *
 * `navigator.clipboard` **只在安全上下文里存在**，而这个面板常常是
 * `http://IP:端口` 直接访问的 —— 那时它是 `undefined`，直接 `await` 它会抛。
 *
 * 动手前全站数过：11 个调用点里
 *   - **3 处连 try/catch 都没有**（插件资源值、插件结果字段、支付回调地址）：
 *     http 面板上点了毫无反应，不弹提示也不报错，按钮像是坏的。支付回调地址
 *     那几个是要贴进支付平台后台的。
 *   - **1 处回退路径不看 `execCommand` 的返回值**，复制没成也照样弹「已复制」。
 *   - **5 处各自抄了一份回退**，用的还是共享实现已经换掉的 textarea 老写法
 *     （Chromium 会返回 true 其实复制了个空，iOS 直接不认），而且把临时元素挂在
 *     `document.body` 上 —— 弹窗里的复制按钮会被焦点陷阱抢回焦点。
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const 共享实现 = path.join("lib", "clipboard.ts");

function collect(dir: string, out: string[] = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.name === "node_modules") continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) collect(full, out);
    else if (/\.tsx?$/.test(item.name) && !/\.test\.tsx?$/.test(item.name)) out.push(full);
  }
  return out;
}

test("只有 lib/clipboard.ts 碰剪贴板 API", () => {
  const offenders: string[] = [];
  let scanned = 0;
  for (const file of collect(ROOT)) {
    const relative = path.relative(ROOT, file);
    if (relative === 共享实现) continue;
    scanned += 1;
    const source = fs.readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    source.split("\n").forEach((line, index) => {
      if (/navigator\s*\.\s*clipboard/.test(line) || /document\s*\.\s*execCommand\s*\(\s*["']copy["']/.test(line)) {
        offenders.push(`${relative}:${index + 1}`);
      }
    });
  }
  assert.ok(scanned > 100, `只扫到 ${scanned} 个文件，扫描逻辑可能失效了`);
  assert.deepEqual(
    offenders,
    [],
    `这些地方绕过了 lib/clipboard.ts。面板跑在 http 上时 navigator.clipboard 是 undefined，\n`
      + `直接用它按钮就是死的；自己抄回退又会漏掉弹窗焦点陷阱和 execCommand 的返回值：\n  `
      + offenders.join("\n  "),
  );
});

test("共享实现自己该有的都在", () => {
  const source = fs.readFileSync(path.join(ROOT, 共享实现), "utf8");
  assert.match(source, /window\.isSecureContext/, "要先判断安全上下文");
  assert.match(source, /contentEditable/, "回退要用 contenteditable，textarea 那条路 iOS 不认");
  assert.match(source, /role="dialog"/, "临时元素要挂在打开着的弹窗里，否则被焦点陷阱抢走");
  assert.match(source, /Promise<boolean>/, "要如实回报成没成，调用方才能决定弹什么");
});
