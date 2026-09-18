import assert from "node:assert/strict";
import test from "node:test";

import {
  LINK_PROBE_FRESH_MS,
  LINK_PROBE_MAX_FUTURE_SKEW_MS,
  isLinkProbeFresh,
} from "./linkProbePolicy";
import { isProbeFresh } from "./proxyNodeHealth";

/**
 * 「这次探测还算不算数」原来在五个地方各写一遍，而 Telegram 那一路一个都没写。
 * 这一组把口径钉死，并且盯住那几种会把窗口悄悄放宽的写法。
 */
test("探测新鲜期：过期的、来自未来的、解析不出来的都不算数", () => {
  const now = 1_700_000_000_000;

  assert.equal(isLinkProbeFresh(now, now), true, "刚刚探的当然算数");
  assert.equal(isLinkProbeFresh(now - LINK_PROBE_FRESH_MS, now), true, "正好卡在窗口边界上仍算数");
  assert.equal(
    isLinkProbeFresh(now - LINK_PROBE_FRESH_MS - 1, now),
    false,
    "过了新鲜期就该当作没探测过：三天前那次超时说明不了此刻通不通",
  );

  assert.equal(isLinkProbeFresh(now + LINK_PROBE_MAX_FUTURE_SKEW_MS, now), true, "允许一点点时钟偏差");
  assert.equal(
    isLinkProbeFresh(now + LINK_PROBE_MAX_FUTURE_SKEW_MS + 1, now),
    false,
    "偏差太大的不认 —— 否则一个钟走快了的 Agent 能让它那条线路永远显示新鲜",
  );

  assert.equal(isLinkProbeFresh(0, now), false, "没探测过");
  assert.equal(isLinkProbeFresh(null, now), false);
  assert.equal(isLinkProbeFresh(undefined, now), false);
  assert.equal(isLinkProbeFresh("不是时间", now), false, "解析不出来的时间戳不能当成新鲜");
});

test("秒和毫秒都认得出来", () => {
  const now = 1_700_000_000_000;
  const seconds = Math.floor((now - 60_000) / 1000);
  assert.equal(
    isLinkProbeFresh(seconds, now),
    true,
    "Agent 那边有的字段报的是秒；按毫秒解释会落在 1970 年，于是一条刚探过的线路被判成过期",
  );
  assert.equal(isLinkProbeFresh(new Date(now - 60_000), now), true, "Date 也要认");
  assert.equal(isLinkProbeFresh(new Date(now - 60_000).toISOString(), now), true, "字符串也要认");
});

test("节点健康那一路用的是同一把尺子", () => {
  const now = 1_700_000_000_000;
  for (const at of [now, now - LINK_PROBE_FRESH_MS, now - LINK_PROBE_FRESH_MS - 1, now + LINK_PROBE_MAX_FUTURE_SKEW_MS + 1, 0]) {
    assert.equal(
      isProbeFresh(at, now),
      isLinkProbeFresh(at, now),
      `两处对 ${at} 给了不同答案 —— 同一条线路会在两屏之间变色`,
    );
  }
});
