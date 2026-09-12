import assert from "node:assert/strict";
import test from "node:test";

import { canReadHostInstallCommand } from "./routers/hosts";

/**
 * 「谁能看这台主机的 Agent 安装命令」。
 *
 * 命令里带 agentToken：拿到的人能把任意一台机器接进面板顶着这个身份上报。
 * 所以它跟「能不能用这台主机」是两回事 —— 被授权用，不等于能拿令牌。
 */
const admin = { id: 1, role: "admin" };
const owner = { id: 2, role: "user" };
const other = { id: 3, role: "user" };

test("主人能看自己机器的命令", () => {
  assert.equal(canReadHostInstallCommand(owner, { userId: owner.id }), true);
});

test("管理员能看任何一台", () => {
  assert.equal(canReadHostInstallCommand(admin, { userId: owner.id }), true);
  assert.equal(canReadHostInstallCommand(admin, { userId: null }), true);
});

test("别人的机器看不了，哪怕他被授权用这台", () => {
  // 授权只影响「能不能在上面开节点」，跟令牌无关，所以这里没有第三个参数可传。
  assert.equal(canReadHostInstallCommand(other, { userId: owner.id }), false);
});

test("没有主人的机器（管理员建的）租户看不了", () => {
  assert.equal(canReadHostInstallCommand(other, { userId: null }), false);
  assert.equal(canReadHostInstallCommand(other, { userId: 0 }), false);
});

test("主机不存在时一律不给", () => {
  assert.equal(canReadHostInstallCommand(admin, null), false);
  assert.equal(canReadHostInstallCommand(owner, undefined), false);
});

test("数据库回来的 userId 是字符串时，主人仍然是主人", () => {
  // 用 === 比的话这条会判成外人，主人拿不到自己机器的命令。
  assert.equal(canReadHostInstallCommand(owner, { userId: String(owner.id) }), true);
  assert.equal(canReadHostInstallCommand(other, { userId: String(owner.id) }), false);
});
