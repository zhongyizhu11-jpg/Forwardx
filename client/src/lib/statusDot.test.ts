import assert from "node:assert/strict";
import test from "node:test";

import { resourceStatusTone } from "./statusDot";

/**
 * 绿 / 黄 / 灰是三个**语义档位**，不是装饰：能用 / 配着但没跑起来 / 没了或停用。
 *
 * 流量计费配置页和套餐管理页摆的是同一批资源，原来各存一份判定（分支顺序还不一样），
 * 现在合并成一份。同一台机器在两页显示不同颜色，人会以为是两个东西。
 */

test("资源不存在时是灰的，不是离线", () => {
  /*
    「被删掉」和「掉线」是两回事：说成离线会让人以为它还在、只是连不上，
    于是去排查网络 —— 而实际上该做的是把这条配置删掉。
  */
  assert.equal(resourceStatusTone("host", null), "offline");
  assert.equal(resourceStatusTone("host", { missing: true, isOnline: true }), "offline",
    "标了 missing 就是没了，哪怕还带着 isOnline");
});

test("主机只看在线与否", () => {
  assert.equal(resourceStatusTone("host", { isOnline: true }), "online");
  assert.equal(resourceStatusTone("host", { isOnline: false }), "offline");
});

test("隧道分三档：跑着 / 配了没跑 / 停用", () => {
  assert.equal(resourceStatusTone("tunnel", { isRunning: true, isEnabled: true }), "online");
  assert.equal(resourceStatusTone("tunnel", { isRunning: false, isEnabled: true }), "warning",
    "启用了但没跑起来是黄的 —— 这正是要人去看一眼的状态");
  assert.equal(resourceStatusTone("tunnel", { isRunning: false, isEnabled: false }), "offline");
});

test("转发组等其它资源：停用灰、报错灰、探测超时黄、其余绿", () => {
  assert.equal(resourceStatusTone("forward_group", { isEnabled: false }), "offline");
  assert.equal(resourceStatusTone("forward_group", { lastStatus: "error" }), "offline");
  assert.equal(resourceStatusTone("forward_group", { lastStatus: "ERROR" }), "offline", "状态大小写不该影响判断");
  assert.equal(resourceStatusTone("forward_group", { latestLatencyIsTimeout: true }), "warning");
  assert.equal(resourceStatusTone("forward_group", {}), "online");
});

test("停用优先于探测超时", () => {
  // 一个停用了的转发组，上一次探测超时是历史残留，不该盖过「你自己关掉了」。
  assert.equal(resourceStatusTone("forward_group", { isEnabled: false, latestLatencyIsTimeout: true }), "offline");
});
