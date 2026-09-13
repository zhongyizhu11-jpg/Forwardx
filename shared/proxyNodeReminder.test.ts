import assert from "node:assert/strict";
import test from "node:test";

import { planProxyNodeTrafficReminder, proxyNodeTrafficReminderKey } from "./proxyNodeReminder";

const GB = 1024 ** 3;

test("没填总量就不提醒 —— 没有上限就谈不上用了多少算多", () => {
  const plan = planProxyNodeTrafficReminder({ trafficUsed: 900 * GB });
  assert.equal(plan.due, false);
  assert.equal(plan.state, "none");
  assert.equal(plan.usedPercent, 0);
});

test("到阈值才提醒，没到不吵", () => {
  const under = planProxyNodeTrafficReminder({ trafficLimit: 100 * GB, trafficUsed: 50 * GB });
  assert.equal(under.due, false);
  assert.equal(under.state, "normal");

  const warn = planProxyNodeTrafficReminder({ trafficLimit: 100 * GB, trafficUsed: 85 * GB });
  assert.equal(warn.due, true);
  assert.equal(warn.state, "warn");
  assert.equal(warn.usedPercent, 85);
});

test("跑满了是另一个状态 —— 那一封才是要紧的", () => {
  const plan = planProxyNodeTrafficReminder({ trafficLimit: 100 * GB, trafficUsed: 140 * GB });
  assert.equal(plan.state, "exceeded");
  assert.equal(plan.due, true);
  assert.equal(plan.usedPercent, 140);
});

test("阈值跟界面那个仪表盘同源，不另立一套", () => {
  const plan = planProxyNodeTrafficReminder({ trafficLimit: 100 * GB, trafficUsed: 1 });
  // 差一点点到阈值时不该提醒；正好到阈值要提醒。
  const justUnder = planProxyNodeTrafficReminder({
    trafficLimit: 100 * GB,
    trafficUsed: Math.floor((plan.warnPercent - 1) / 100 * 100 * GB),
  });
  const atThreshold = planProxyNodeTrafficReminder({
    trafficLimit: 100 * GB,
    trafficUsed: Math.floor(plan.warnPercent / 100 * 100 * GB),
  });
  assert.equal(justUnder.due, false);
  assert.equal(atThreshold.due, true);
});

test("脏数据不至于误报：负数当 0", () => {
  const plan = planProxyNodeTrafficReminder({ trafficLimit: -1, trafficUsed: -5 });
  assert.equal(plan.due, false);
  assert.equal(plan.usedBytes, 0);
  assert.equal(plan.limitBytes, 0);
});

test("去重键带状态：先发了「快满」，真跑满时还要能再发一次", () => {
  assert.notEqual(
    proxyNodeTrafficReminderKey(7, "warn"),
    proxyNodeTrafficReminderKey(7, "exceeded"),
  );
  assert.equal(proxyNodeTrafficReminderKey(7, "warn"), "proxyNodeTraffic:7:warn");
});
