import assert from "node:assert/strict";
import test from "node:test";

import { hostOwnerLabel } from "./routers/hosts";

/**
 * 主机列表上「这台机器是谁的」。
 *
 * 租户可以自助加机器，加完就出现在管理员的主机管理里 —— 那是对的（面板是管理员
 * 在跑，出了事要能查、要能删）。但原来一个字都没标，管理员看到的是一台凭空多出来
 * 的陌生机器：不知道能不能动它，也不知道该找谁。
 */
const admin = { id: 1, role: "admin" };
const tenant = { id: 5, role: "user" };
const names = new Map<number, string>([[5, "张三"], [7, "李四"]]);

test("管理员看别人的机器要标出主人", () => {
  assert.equal(hostOwnerLabel(admin, { userId: 5 }, names), "张三");
  assert.equal(hostOwnerLabel(admin, { userId: 7 }, names), "李四");
});

test("自己建的不标 —— 满屏自己的名字等于没标", () => {
  assert.equal(hostOwnerLabel(admin, { userId: admin.id }, names), null);
});

/**
 * 这一条是隐私边界，不是显示偏好：普通用户能看见的机器除了自己的，还有被管理员
 * 授权、或套餐附带的别人的机器。在那儿标出主人，等于把另一个租户的身份透给他。
 */
test("普通用户一律不标，哪怕看的是别人的机器", () => {
  assert.equal(hostOwnerLabel(tenant, { userId: 7 }, names), null);
  assert.equal(hostOwnerLabel(tenant, { userId: tenant.id }, names), null);
  assert.equal(hostOwnerLabel({ id: 9, role: "user" }, { userId: 5 }, names), null);
});

test("主人已经注销了也要说，不能静悄悄当成自己的", () => {
  assert.equal(
    hostOwnerLabel(admin, { userId: 999 }, names),
    "已注销用户 #999",
    "一台没人认领的机器恰恰最该被管理员看见",
  );
});

test("没有主人字段时不硬编一个", () => {
  assert.equal(hostOwnerLabel(admin, {}, names), null);
  assert.equal(hostOwnerLabel(admin, { userId: 0 }, names), null);
  assert.equal(hostOwnerLabel(admin, { userId: null }, names), null);
});
