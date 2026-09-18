import assert from "node:assert/strict";
import test from "node:test";
import { autoForwardRuleName, resolveForwardRuleName } from "./forwardRuleName";

/**
 * 没填名字时替用户起的那个名字。
 *
 * 这个字段原来是必填的，纯粹为了「列表里认得出是哪条」—— 却拦住了
 * 「填完端口和目标就能保存」。现在留空由服务端兜底，所以兜底值得盯：
 * 它会直接写进库，用户之后看到的就是它。
 */

test("优先用目标地址，因为那最能说明这条转发是干嘛的", () => {
  assert.equal(autoForwardRuleName({ targetIp: "10.9.9.9", targetPort: 8080 }), "10.9.9.9:8080");
  assert.equal(autoForwardRuleName({ targetIp: "example.com", targetPort: 443 }), "example.com:443");
});

test("IPv6 目标要带方括号", () => {
  // 不带的话 `2001:db8::1:80` 根本分不清哪一段是端口。
  assert.equal(autoForwardRuleName({ targetIp: "2001:db8::1", targetPort: 80 }), "[2001:db8::1]:80");
  // 上游已经带了方括号的不要再包一层。
  assert.equal(autoForwardRuleName({ targetIp: "[2001:db8::1]", targetPort: 80 }), "[2001:db8::1]:80");
});

test("没有目标端口就只用地址，不留一个光秃秃的冒号", () => {
  assert.equal(autoForwardRuleName({ targetIp: "10.9.9.9", targetPort: 0 }), "10.9.9.9");
  assert.equal(autoForwardRuleName({ targetIp: "10.9.9.9" }), "10.9.9.9");
});

test("连目标都没有才退到源端口", () => {
  assert.equal(autoForwardRuleName({ sourcePort: 24123 }), "转发 24123");
  // 源端口 0 表示「由面板随机分配」，这时候还没有号可用，不能拿 0 当名字。
  assert.equal(autoForwardRuleName({ sourcePort: 0 }), "未命名转发");
  assert.equal(autoForwardRuleName({}), "未命名转发");
});

test("用户填了就用用户的，只有空白算没填", () => {
  const from = { targetIp: "10.9.9.9", targetPort: 8080 };
  assert.equal(resolveForwardRuleName("我的转发", from), "我的转发");
  // 前后空格要去掉，但不能因此把整个名字吃掉。
  assert.equal(resolveForwardRuleName("  我的转发  ", from), "我的转发");
  assert.equal(resolveForwardRuleName("", from), "10.9.9.9:8080");
  assert.equal(resolveForwardRuleName("   ", from), "10.9.9.9:8080");
  assert.equal(resolveForwardRuleName(undefined, from), "10.9.9.9:8080");
  assert.equal(resolveForwardRuleName(null, from), "10.9.9.9:8080");
});
