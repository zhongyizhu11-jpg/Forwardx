import assert from "node:assert/strict";
import test from "node:test";
import { avatarQuotaState } from "./avatarQuota";

test("管理员和不限额的都不受限", () => {
  assert.equal(avatarQuotaState({ remaining: 0 }, true).exhausted, false, "管理员不受限");
  assert.equal(avatarQuotaState({ remaining: 0, unlimited: true }, false).exhausted, false);
});

test("额度用完才拦", () => {
  assert.equal(avatarQuotaState({ remaining: 2 }, false).exhausted, false);
  assert.equal(avatarQuotaState({ remaining: 1 }, false).exhausted, false);
  assert.equal(avatarQuotaState({ remaining: 0 }, false).exhausted, true);
  assert.equal(avatarQuotaState({ remaining: -1 }, false).exhausted, true, "负数也算用完");
});

test("查询还没回来时按 3 次算，不要拦住用户", () => {
  // 默认值取的是个人资料页原来的写法；改成 0 会在查询回来前把保存按钮拦死
  assert.deepEqual(avatarQuotaState(undefined, false), { remaining: 3, unlimited: false, exhausted: false });
  assert.deepEqual(avatarQuotaState(null, false), { remaining: 3, unlimited: false, exhausted: false });
  assert.equal(avatarQuotaState({ remaining: null }, false).remaining, 3);
});
