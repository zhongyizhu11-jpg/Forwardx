import assert from "node:assert/strict";
import test from "node:test";
import { Circle } from "lucide-react";

import { activeTabPath, MORE_TAB_PATH, pickTabBarItems } from "./tabBar";

const dest = (path: string, label = path) => ({ path, label, icon: Circle });
const more = dest(MORE_TAB_PATH, "更多");

test("按优先级挑，挑不到的跳过而不是留空格", () => {
  /*
    一个只有转发权限的租户拿不到 /hosts。上一版会给他一个点进去 403 的空 Tab ——
    挑选必须发生在权限过滤之后。
  */
  const plan = pickTabBarItems({
    destinations: [dest("/"), dest("/rules")],
    preferred: ["/", "/hosts", "/rules"],
    more,
  });
  assert.deepEqual(plan.tabs.map((t) => t.path), ["/", "/rules"]);
  assert.equal(plan.hasMore, false);
});

test("装不下时最后一格让给「更多」，挤出来的进 overflow 而不是丢掉", () => {
  const plan = pickTabBarItems({
    destinations: ["/", "/rules", "/hosts", "/tunnels", "/subs", "/users"].map((p) => dest(p)),
    preferred: ["/", "/rules", "/hosts", "/tunnels", "/subs"],
    more,
    max: 5,
  });
  assert.equal(plan.tabs.length, 5);
  assert.equal(plan.tabs[4].path, MORE_TAB_PATH);
  assert.deepEqual(plan.tabs.slice(0, 4).map((t) => t.path), ["/", "/rules", "/hosts", "/tunnels"]);
  // 被挤掉的 /subs 和没进优先级表的 /users 都要在「更多」里找得到
  assert.deepEqual(plan.overflow.map((t) => t.path), ["/subs", "/users"]);
});

test("全部装得下就不要「更多」那一格", () => {
  // 点进去只有两项的「更多」比没有它更让人困惑：用户会以为自己漏了什么。
  const plan = pickTabBarItems({
    destinations: [dest("/"), dest("/rules")],
    preferred: ["/", "/rules"],
    more,
  });
  assert.equal(plan.hasMore, false);
  assert.equal(plan.overflow.length, 0);
  assert.ok(!plan.tabs.some((t) => t.path === MORE_TAB_PATH));
});

test("优先级表里重复的路径只占一格", () => {
  const plan = pickTabBarItems({
    destinations: [dest("/"), dest("/rules")],
    preferred: ["/", "/", "/rules"],
    more,
  });
  assert.deepEqual(plan.tabs.map((t) => t.path), ["/", "/rules"]);
});

test("不在 Tab 上的页面点亮「更多」，层级再深也知道自己在哪一格", () => {
  const plan = pickTabBarItems({
    destinations: ["/", "/rules", "/hosts", "/tunnels", "/subs", "/users"].map((p) => dest(p)),
    preferred: ["/", "/rules", "/hosts", "/tunnels", "/subs"],
    more,
  });
  assert.equal(activeTabPath(plan, "/rules"), "/rules");
  assert.equal(activeTabPath(plan, "/users"), MORE_TAB_PATH);
  assert.equal(activeTabPath(plan, "/subs"), MORE_TAB_PATH);
});

test("没有「更多」时，不认识的路径不点亮任何一格", () => {
  const plan = pickTabBarItems({
    destinations: [dest("/"), dest("/rules")],
    preferred: ["/", "/rules"],
    more,
  });
  assert.equal(activeTabPath(plan, "/profile"), null);
});
