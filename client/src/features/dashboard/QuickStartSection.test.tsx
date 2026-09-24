import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { SystemHealth } from "@/components/SystemStatusHeader";
import { QuickStartSection, buildQuickStartSteps } from "./QuickStartSection";

const health = (hosts: { total: number; online: number }, forwards: number): SystemHealth => ({
  hosts: { total: hosts.total, online: hosts.online, offline: hosts.total - hosts.online, neverConnected: 0 },
  links: { total: 0, healthy: 0, unhealthy: 0 },
  forwards: { total: forwards, running: forwards, stalled: 0, disabled: 0 },
  issues: 0,
});

const render = (value: SystemHealth | undefined, isAdmin = true) => renderToStaticMarkup(
  <QuickStartSection health={value} isAdmin={isAdmin} onOpen={() => {}} />,
);

test("按顺序三步：加主机 → 等上线 → 建第一条转发，做完一步勾一步", () => {
  assert.deepEqual(buildQuickStartSteps(health({ total: 0, online: 0 }, 0)).map((step) => step.done), [false, false, false]);
  assert.deepEqual(buildQuickStartSteps(health({ total: 1, online: 0 }, 0)).map((step) => step.done), [true, false, false]);
  assert.deepEqual(buildQuickStartSteps(health({ total: 1, online: 1 }, 0)).map((step) => step.done), [true, true, false]);
  assert.equal(buildQuickStartSteps(health({ total: 1, online: 1 }, 0))[2].href, "/rules?create=local", "最后一步直接打开「添加转发规则」");
});

test("新装的面板：管理员看得到，写着进度和「不再显示」", () => {
  const html = render(health({ total: 1, online: 0 }, 0));
  assert.match(html, /快速开始 · 已完成 1\/3/);
  assert.match(html, /等主机上线/);
  assert.match(html, /不再显示/);
});

test("三步都做完、租户、数据还没回来：整块都不出现", () => {
  assert.equal(render(health({ total: 2, online: 2 }, 5)), "");
  assert.equal(render(health({ total: 0, online: 0 }, 0), false), "", "租户不装主机，这三步不是他的");
  assert.equal(render(undefined), "", "先闪一下「0 台主机」再变成 20 台，比不显示更糟");
});
