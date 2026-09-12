import assert from "node:assert/strict";
import test from "node:test";

import { canOpenInboundOnHost } from "./routers/proxyInbounds";

/**
 * 「能在哪台机器上开落地节点」这条判定。
 *
 * 错向任一边都很难看：松了，租户能在别人的机器上占端口；紧了，他加了自己的
 * VPS 却用不了，而界面还写着「先去主机管理装一台」。
 */
const admin = { id: 1, role: "admin" };
const tenant = { id: 2, role: "user" };
const other = { id: 3, role: "user" };

test("自己的机器可以开", () => {
  // 这条原来是漏的：hosts.create 不是管理员专属，租户加得了机器却开不了节点。
  const own = { userId: tenant.id };
  assert.equal(canOpenInboundOnHost(tenant, own, [], 10), true);
});

test("别人的机器，没授权就不行", () => {
  const someoneElses = { userId: other.id };
  assert.equal(canOpenInboundOnHost(tenant, someoneElses, [], 10), false);
});

test("别人的机器，拿到授权就行", () => {
  // 授权列表用的是「有效授权」，套餐附带的主机也在里面。
  const someoneElses = { userId: other.id };
  assert.equal(canOpenInboundOnHost(tenant, someoneElses, [10], 10), true);
});

test("授权是按主机算的，不是一给就全给", () => {
  const someoneElses = { userId: other.id };
  assert.equal(canOpenInboundOnHost(tenant, someoneElses, [11, 12], 10), false);
});

test("管理员哪台都行", () => {
  assert.equal(canOpenInboundOnHost(admin, { userId: other.id }, [], 10), true);
});

test("主机不存在时一律不行", () => {
  // 调用方会先抛「主机不存在」，但这里也不能返回 true —— 判定函数自己要站得住。
  assert.equal(canOpenInboundOnHost(admin, null, [], 10), false);
  assert.equal(canOpenInboundOnHost(tenant, undefined, [10], 10), false);
});

test("主人判定按值比较，字符串 id 不会漏掉", () => {
  /**
   * 主机行是从数据库读出来的，不同驱动回来的 userId 可能是字符串。
   * 用 === 比较的话，自己的机器会被判成别人的 —— 表现就是「明明是我的机器却说无权」。
   */
  assert.equal(canOpenInboundOnHost(tenant, { userId: "2" }, [], 10), true);
  assert.equal(canOpenInboundOnHost(tenant, { userId: "3" }, [], 10), false);
});

test("授权列表里是字符串 id 也认", () => {
  const someoneElses = { userId: other.id };
  assert.equal(canOpenInboundOnHost(tenant, someoneElses, ["10" as unknown as number], 10), true);
});
