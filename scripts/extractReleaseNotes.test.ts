import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 发布说明的取法。
 *
 * 这一组盯的是一件真实发生过的事：上一个 Release 是 v2.3.320，main 已经到
 * v2.3.338，而脚本只取最后那一节 —— 于是十八个版本的改动一句话都不会出现在
 * 发布说明里，看的人会以为这一版只改了它最后碰的那一处。
 *
 * 另一半用例写的是「别为了发布说明挡住发布」：上一个发布解析不出来、或者比这次
 * 还新（回滚、重跑旧 tag），都要退回只取一节并且**正常退出**。
 */
const CHANGELOG = `# Changelog

## [1.2.5] - 2026-01-05

### 新增

- 第五版：加了 E。

## [1.2.4] - 2026-01-04

### 修复

- 第四版：修了 D。

## [1.2.3] - 2026-01-03

### 新增

- 第三版：加了 C。

## [1.2.2] - 2026-01-02

### 修复

- 第二版：修了 B。
`;

function run(args: string[]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-notes-"));
  try {
    fs.writeFileSync(path.join(directory, "CHANGELOG.md"), CHANGELOG);
    return spawnSync(process.execPath, ["scripts/extract-release-notes.mjs", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, FORWARDX_CHANGELOG_PATH: path.join(directory, "CHANGELOG.md") },
      timeout: 30_000,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("不给上一个发布：只取这一节，不带版本号标题", () => {
  const result = run(["1.2.5"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /第五版/);
  assert.doesNotMatch(result.stdout, /第四版/);
  // 自己那一页上再写一遍自己的版本号是废话。
  assert.doesNotMatch(result.stdout, /^## v1\.2\.5/m);
});

test("给了上一个发布：把这中间每一版都写进去", () => {
  const result = run(["1.2.5", "1.2.2"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /共 3 个版本/);
  assert.match(result.stdout, /^## v1\.2\.5/m);
  assert.match(result.stdout, /^## v1\.2\.4/m);
  assert.match(result.stdout, /^## v1\.2\.3/m);
  assert.match(result.stdout, /第五版[\s\S]*第四版[\s\S]*第三版/, "顺序是新的在前");
  // 上一个发布本身已经发过了，不该再出现一遍。
  assert.doesNotMatch(result.stdout, /^## v1\.2\.2/m);
  assert.doesNotMatch(result.stdout, /第二版/);
});

test("v 前缀两种写法都认", () => {
  const result = run(["v1.2.5", "v1.2.3"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /共 2 个版本/);
  assert.doesNotMatch(result.stdout, /第三版/);
});

test("紧挨着的上一版：仍然走单节格式", () => {
  const result = run(["1.2.5", "1.2.4"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /第五版/);
  assert.doesNotMatch(result.stdout, /^## v1\.2\.5/m);
  assert.doesNotMatch(result.stdout, /共 \d+ 个版本/);
});

test("上一个发布在 CHANGELOG 里找不到：退回单节，不能挡住发布", () => {
  const result = run(["1.2.5", "0.9.9"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /第五版/);
  assert.match(result.stderr, /0\.9\.9/, "要留一句话说明为什么退回去了");
});

test("上一个发布比这次还新（回滚、重跑旧 tag）：退回单节", () => {
  const result = run(["1.2.3", "1.2.5"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /第三版/);
  assert.doesNotMatch(result.stdout, /第五版/);
});

test("上一个发布就是自己：退回单节", () => {
  const result = run(["1.2.5", "1.2.5"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /第五版/);
  assert.doesNotMatch(result.stdout, /共 \d+ 个版本/);
});

test("版本号不合法、或 CHANGELOG 里没有这一节：必须失败", () => {
  assert.notEqual(run(["nonsense"]).status, 0);
  assert.notEqual(run([]).status, 0);
  // 这一条是发布的最后一道闸：忘了写 CHANGELOG 就不该发出去。
  assert.notEqual(run(["9.9.9"]).status, 0);
});
