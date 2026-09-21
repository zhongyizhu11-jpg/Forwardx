import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 手册硬性要求：**密码框必须有「显示 / 隐藏」**。
 *
 * 原来全站 32 个密码框里只有登录页那两个有，其余 30 个只能盲打 —— 填 API Token、
 * 商户密钥、SMTP 密码这类又长又杂的串时，看不见就只能靠重填一遍来确认。
 *
 * 现在只许通过 `ui/password-input.tsx` 这一个组件写密码框。写死
 * `type="password"` 或者自己拼一个 `showX ? "text" : "password"`，都说明又绕过去了。
 *
 * 为什么钉「只有一处」而不是「每处都得有眼睛图标」：登录页原来那两个是手写的，
 * 图标、位置、`tabIndex` 各是一套 —— 其中 `tabIndex={-1}` 让键盘用户根本点不到
 * 「显示密码」。抄第二遍就会有第二套行为，所以干脆只留一份。
 */

const ROOT = path.resolve(import.meta.dirname);
const 组件 = path.join("components", "ui", "password-input.tsx");

function collectTsx(dir: string, out: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTsx(full, out);
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

test("密码框只通过 PasswordInput 写", () => {
  const offenders: string[] = [];
  let 组件存在 = false;
  for (const file of collectTsx(ROOT)) {
    const relative = path.relative(ROOT, file);
    if (relative === 组件) { 组件存在 = true; continue; }
    const source = fs.readFileSync(file, "utf8");
    source.split("\n").forEach((line, index) => {
      // 写死的 type="password"，或者自己拼的明文/密文切换
      if (/type=\{?"password"/.test(line) || /\?\s*"text"\s*:\s*"password"/.test(line) || /\?\s*"password"\s*:\s*"text"/.test(line)) {
        offenders.push(`${relative}:${index + 1}`);
      }
    });
  }
  assert.ok(组件存在, "找不到 components/ui/password-input.tsx");
  assert.deepEqual(
    offenders,
    [],
    `这些地方绕过了 PasswordInput，用户只能盲打：\n  ${offenders.join("\n  ")}`,
  );
});

test("PasswordInput 自己该有的都有", () => {
  /*
    注释要先剥掉。第一版没剥，结果 `tabIndex={-1}` 在组件自己的说明里被匹配到
    （那段注释正是在解释「登录页原来写了 tabIndex={-1}，所以这里不写」），
    测试红在一条它本来要禁止的写法的**说明文字**上。
  */
  const source = fs.readFileSync(path.join(ROOT, 组件), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.match(source, /aria-label=\{revealed \? "隐藏密码" : "显示密码"\}/, "切换按钮要有可访问名称");
  assert.match(source, /aria-pressed=\{revealed\}/, "读屏要能念出当前是显示还是隐藏");
  assert.doesNotMatch(source, /tabIndex=\{-1\}/, "切换按钮必须能用键盘聚焦");
  assert.match(source, /focus-visible:ring/, "键盘聚焦要看得见");
});
