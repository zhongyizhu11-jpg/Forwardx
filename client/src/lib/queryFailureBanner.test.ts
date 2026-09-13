import assert from "node:assert/strict";
import test from "node:test";

import { queryFailureBannerText, shouldShowQueryFailureBanner } from "./queryFailureBanner";

const base = { failureCount: 0, failingSinceMs: 0, dismissedAtCount: 0, now: 100_000 };

test("没有失败就不提示", () => {
  assert.equal(shouldShowQueryFailureBanner(base), false);
  // 有失败数但没有起始时间，是状态没对齐，按不提示处理（宁可漏一次也不要乱弹）。
  assert.equal(shouldShowQueryFailureBanner({ ...base, failureCount: 3 }), false);
});

test("失败刚发生时不提示 —— 轮询抖一下不该闪横幅", () => {
  assert.equal(
    shouldShowQueryFailureBanner({ ...base, failureCount: 2, failingSinceMs: 98_000 }),
    false,
  );
  assert.equal(
    shouldShowQueryFailureBanner({ ...base, failureCount: 2, failingSinceMs: 96_000 }),
    true,
    "持续 4 秒就该说了",
  );
});

test("关掉之后同一批不再弹，新的失败还要说", () => {
  const failing = { ...base, failureCount: 2, failingSinceMs: 90_000, dismissedAtCount: 2 };
  assert.equal(shouldShowQueryFailureBanner(failing), false);
  assert.equal(
    shouldShowQueryFailureBanner({ ...failing, failureCount: 3 }),
    true,
    "又多坏了一项，不能因为关过就永久静音",
  );
});

test("文案把数量说清楚", () => {
  assert.equal(queryFailureBannerText(1), "有 1 项数据没读到，这一页显示的可能不全。");
  assert.match(queryFailureBannerText(5), /有 5 项/);
  // 计数出了偏差也不能写成「有 0 项」。
  assert.match(queryFailureBannerText(0), /有 1 项/);
});
