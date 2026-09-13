import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeProxySubTokenFailureReason,
  proxySubTokenStatus,
  PROXY_SUB_TOKEN_FAILURE_LABELS,
} from "./proxySubTokenStatus";

const T1 = new Date("2026-09-13T10:00:00Z");
const T2 = new Date("2026-09-13T11:00:00Z");

test("从没被拉过就是从没被拉过", () => {
  assert.deepEqual(proxySubTokenStatus({}), { kind: "never" });
  // 只有失败原因、没有时间，是半条脏数据，不据此下结论。
  assert.deepEqual(proxySubTokenStatus({ lastFailureReason: "disabled" }), { kind: "never" });
});

test("失败在后就说失败 —— 商家要的正是这句话", () => {
  const status = proxySubTokenStatus({
    lastAccessAt: T1,
    lastFailureAt: T2,
    lastFailureReason: "not-eligible",
  });
  assert.equal(status.kind, "failed");
  assert.equal(status.kind === "failed" && status.reason, "not-eligible");
});

test("失败之后又拉成功了，就别再挂着红字", () => {
  const status = proxySubTokenStatus({
    lastAccessAt: T2,
    lastFailureAt: T1,
    lastFailureReason: "not-eligible",
  });
  assert.equal(status.kind, "ok");
});

test("认不出的失败原因当没有 —— 不显示一句谁也看不懂的话", () => {
  assert.equal(normalizeProxySubTokenFailureReason("莫名其妙"), null);
  assert.equal(normalizeProxySubTokenFailureReason(""), null);
  assert.equal(normalizeProxySubTokenFailureReason("disabled"), "disabled");
  const status = proxySubTokenStatus({ lastFailureAt: T2, lastFailureReason: "莫名其妙" });
  assert.equal(status.kind, "never");
});

test("每个原因都有一句人话", () => {
  for (const [reason, label] of Object.entries(PROXY_SUB_TOKEN_FAILURE_LABELS)) {
    assert.ok(label.length > 0, `${reason} 应该有说明`);
    assert.doesNotMatch(label, /[a-z]{4,}/, `${reason} 的说明不该是英文代码`);
  }
});
