import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { describeRoutePolicy, type RoutePolicyRule } from "@shared/routePolicy";
import { RoutePolicyPanel } from "./RoutePolicySheet";

// 2026-09-22（星期二）上海 20:00：在「工作日 18:00–01:00」里。
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const TZ = "Asia/Shanghai";
const noop = () => {};

const rule = (patch: Partial<Record<keyof RoutePolicyRule, unknown>> = {}): RoutePolicyRule => ({
  failoverEnabled: true,
  failoverStrategy: "fallback",
  targetIp: "198.51.100.7",
  targetPort: 443,
  failoverTargets: JSON.stringify([{ targetIp: "198.51.100.8", targetPort: 443 }]),
  failoverSchedule: JSON.stringify({ timezone: TZ, windows: [{ days: [1, 2, 3, 4, 5], from: "18:00", to: "01:00", targetIndex: 1 }] }),
  failoverActiveTarget: "198.51.100.8:443",
  failoverActiveAt: new Date(NOW - 2 * 3_600_000),
  ...patch,
});

function render(patch: Parameters<typeof rule>[0] = {}, canEdit = true) {
  const policy = describeRoutePolicy(rule(patch), { host: { isOnline: true, agentVersion: "2.2.197" }, nowMs: NOW, timeZone: TZ })!;
  return renderToStaticMarkup(
    <RoutePolicyPanel policy={policy} canEdit={canEdit} onPin={noop} onUnpin={noop} nowMs={NOW} timeZone={TZ} />,
  );
}

test("此刻起作用的那一行高亮，而且只有一行", () => {
  const html = render();
  assert.equal((html.match(/data-state="deciding"/g) || []).length, 1);
  assert.equal((html.match(/>此刻</g) || []).length, 1);
  // 高亮的是时段表那一行，不是兜底的出站顺序。
  assert.match(html, /data-state="deciding"[^]*?工作日 18:00–01:00（次日）/);
});

test("钉着的时候，被压住的时段表那一行明说「被上面那条压着」", () => {
  const html = render({ failoverPinnedIndex: 0, failoverPinnedUntil: new Date(NOW + 3_600_000) });
  assert.match(html, /data-state="overridden"/);
  assert.match(html, /被上面那条压着/);
  assert.match(html, /强制走 主出站/);
  assert.match(html, /交回自动/);
});

test("线路上标出首选和在走", () => {
  const html = render();
  assert.equal((html.match(/>首选</g) || []).length, 1);
  assert.equal((html.match(/>在走</g) || []).length, 1);
  assert.match(html, /现在走 备用 1，18:00 起/);
});

test("没钉着时给入口「强制走一条」；不能改的人看不到这一块", () => {
  assert.match(render(), /强制走一条/);
  assert.doesNotMatch(render({}, false), /人工指定|强制走一条|交回自动/);
});

test("轮询没有「人工指定」这一块，也不说「从上往下」", () => {
  const html = render({ failoverStrategy: "round_robin", failoverSchedule: null });
  assert.doesNotMatch(html, /人工指定|强制走|从上往下/);
  assert.match(html, /每条新连接各走各的/);
});
