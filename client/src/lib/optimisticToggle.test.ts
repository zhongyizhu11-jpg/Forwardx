import assert from "node:assert/strict";
import test from "node:test";
import { settledToggleChecked } from "./optimisticToggle";

test("服务端和请求一致时，显示那个值", () => {
  assert.equal(settledToggleChecked(true, true), true);
  assert.equal(settledToggleChecked(false, false), false);
});

/**
 * 这一条是这个函数存在的理由。
 *
 * 给超额的用户开「转发」：服务端记下意图，但重算后生效值仍然是关。原来的实现在
 * 两者不一致时继续显示**请求值**，于是开关一直亮着 —— 而它是假的。
 */
test("服务端落在别处时，以服务端为准", () => {
  assert.equal(
    settledToggleChecked(false, true),
    false,
    "请求开启但没开成，开关就不能亮着 —— 亮着是在骗人",
  );
  assert.equal(settledToggleChecked(true, false), true, "反方向同理");
});
