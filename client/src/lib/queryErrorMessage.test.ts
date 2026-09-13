import assert from "node:assert/strict";
import test from "node:test";

import { queryErrorHint, queryErrorMessage } from "./queryErrorMessage";

/**
 * 这几行文字决定了失败时页面说什么。判错的后果是「暂无支付流水」这种话 ——
 * 一个刚付过钱的人看到它会直接来找你，所以宁可说得笨一点，也不能说一句假的。
 */

test("原文压成一行并截短，别撑破卡片", () => {
  assert.equal(queryErrorMessage(new Error("  连接\n  超时  ")), "连接 超时");
  assert.equal(queryErrorMessage(new Error("x".repeat(200))).length, 161);
  assert.ok(queryErrorMessage(new Error("x".repeat(200))).endsWith("…"));
});

test("没有原文就不显示那一行", () => {
  assert.equal(queryErrorMessage(null), "");
  assert.equal(queryErrorMessage(undefined), "");
  assert.equal(queryErrorMessage(new Error("   ")), "");
});

test("认得出的失败给人话，认不出的不猜", () => {
  assert.match(queryErrorHint(new Error("UNAUTHORIZED")), /登录/);
  assert.match(queryErrorHint(new Error("FORBIDDEN")), /权限/);
  assert.match(queryErrorHint(new Error("Failed to fetch")), /没连上/);
  // 认不出来就交给原文，别编一个听起来很懂的解释。
  assert.equal(queryErrorHint(new Error("relation \"plans\" does not exist")), "");
  assert.equal(queryErrorHint(null), "");
});
