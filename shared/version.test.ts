import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { compareVersions, isAgentVersionAtLeast, isAgentVersionBehind, normalizeVersion } from "./version";

/**
 * 这把尺子同时管三件事：面板要不要显示「发现新版本」、后端敢不敢给某台 Agent
 * 下发新指令、主机卡上的升级角标亮不亮。原来是四份各自的实现，合成一份之后
 * 语义就必须钉死 —— 它判错一次，要么是对着一台不认识这条指令的 Agent 发过去，
 * 要么是一台早就该升的机器永远不提示。
 */

test("位数不一样时缺的位按 0 补", () => {
  assert.equal(compareVersions("2.3", "2.3.0"), 0, "2.3 和 2.3.0 是同一个版本");
  assert.equal(compareVersions("2.3.1", "2.3"), 1);
  assert.equal(compareVersions("2.3", "2.3.1"), -1);
});

test("按数值比，不按字符串比", () => {
  // 字符串比较会说 "2.3.9" > "2.3.10"，那会让一台已经升到 .10 的机器一直被当成旧版。
  assert.equal(compareVersions("2.3.10", "2.3.9"), 1);
  assert.equal(compareVersions("2.3.361", "2.3.99"), 1);
});

test("前缀 v 和首尾空白不算差异", () => {
  assert.equal(normalizeVersion(" v2.3.1 "), "2.3.1");
  assert.equal(compareVersions("v2.3.1", "2.3.1"), 0);
  assert.equal(compareVersions("V2.3.1", " 2.3.1 "), 0);
});

test("连字符那一段也参与比较", () => {
  assert.equal(compareVersions("2.3.1-2", "2.3.1-1"), 1);
  assert.equal(compareVersions("2.3.1-1", "2.3.1"), 1, "带后缀的算更新");
});

test("非数字段当成 0，不抛错", () => {
  assert.equal(compareVersions("2.3.beta", "2.3.0"), 0);
  assert.equal(compareVersions("", ""), 0);
  assert.equal(compareVersions(null, undefined), 0);
});

test("版本号缺失时一律判「不够」，不判「够」", () => {
  /*
    这条是有方向的：宁可少下发一个新能力，也不能对着一台没上报过版本号的
    Agent 发一条它不认识的指令 —— 后者是直接把那台机器的转发搞挂。
  */
  assert.equal(isAgentVersionAtLeast("", "2.2.187"), false);
  assert.equal(isAgentVersionAtLeast(null, "2.2.187"), false);
  assert.equal(isAgentVersionAtLeast("2.3.1", ""), false, "目标版本没填也不能当成够");
  assert.equal(isAgentVersionAtLeast("2.2.187", "2.2.187"), true, "等于门槛就算够");
  assert.equal(isAgentVersionAtLeast("2.2.188", "2.2.187"), true);
  assert.equal(isAgentVersionAtLeast("2.2.186", "2.2.187"), false);
});

test("版本号缺失时也不提示升级", () => {
  // 一台刚接上、还没上报版本的机器不该立刻挂个「该升级」的角标。
  assert.equal(isAgentVersionBehind("", "2.3.361"), false);
  assert.equal(isAgentVersionBehind("2.3.361", null), false);
  assert.equal(isAgentVersionBehind("2.3.360", "2.3.361"), true);
  assert.equal(isAgentVersionBehind("2.3.361", "2.3.361"), false, "一样新不算落后");
  assert.equal(isAgentVersionBehind("2.3.362", "2.3.361"), false, "比面板还新也不算落后");
});

test("「够门槛」和「落后」是互补的，不能同时成立", () => {
  for (const [a, b] of [["2.3.1", "2.3.1"], ["2.3.2", "2.3.1"], ["2.3.0", "2.3.1"], ["v2.3", "2.3.0"]]) {
    assert.notEqual(
      isAgentVersionAtLeast(a, b),
      isAgentVersionBehind(a, b),
      `${a} vs ${b}：同一对版本号在两个问法下要给出相反的答案`,
    );
  }
});

test("版本比较只有一处实现", () => {
  /*
    这个文件头上写着「全站唯一一份」，但 client/src/lib/mobileNotifications.ts 里
    一直另有一份漏网的 —— 它按 "." 切而不是 `[.-]`，带后缀的版本号会被当成 x.y.0。
    11 对样本里 4 对结论不同。这条盯着别再长出第五份。
  */
  const root = path.resolve(import.meta.dirname, "..");
  const 自己 = path.join("shared", "version.ts");
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", "dist", ".dev"].includes(item.name)) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(item.name) || /\.test\.tsx?$/.test(item.name)) continue;
      const relative = path.relative(root, full);
      if (relative === 自己) continue;
      const source = fs.readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/function\s+(compareVersions|normalizeVersion)\s*[(<]/.test(source)) hits.push(relative);
    }
  };
  for (const dir of ["server", "shared", "client/src"]) walk(path.join(root, dir));
  assert.deepEqual(hits, [], `这些文件又自己写了一份版本比较，请改用 shared/version.ts：\n  ${hits.join("\n  ")}`);
});
