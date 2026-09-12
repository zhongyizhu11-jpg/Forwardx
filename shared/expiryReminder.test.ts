import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_EXPIRY_REMINDER_DAYS,
  parseExpiryReminderDays,
  shouldSendExpiryReminder,
} from "./expiryReminder";

test("没配就用默认档位", () => {
  assert.deepEqual(parseExpiryReminderDays(null), DEFAULT_EXPIRY_REMINDER_DAYS);
  assert.deepEqual(parseExpiryReminderDays(""), DEFAULT_EXPIRY_REMINDER_DAYS);
  assert.deepEqual(parseExpiryReminderDays("   "), DEFAULT_EXPIRY_REMINDER_DAYS);
});

test("逗号、中文逗号、空格都当分隔符，去重并从远到近排", () => {
  assert.deepEqual(parseExpiryReminderDays("3,7,1"), [7, 3, 1]);
  assert.deepEqual(parseExpiryReminderDays("7，3 1"), [7, 3, 1]);
  assert.deepEqual(parseExpiryReminderDays("3,3,3"), [3]);
});

test("脏数据退回默认，而不是变成「一声不吭地不提醒」", () => {
  // 解析成空数组等于悄悄关掉提醒，而管理员从界面上看不出自己填错了。
  assert.deepEqual(parseExpiryReminderDays("abc"), DEFAULT_EXPIRY_REMINDER_DAYS);
  assert.deepEqual(parseExpiryReminderDays("-1"), DEFAULT_EXPIRY_REMINDER_DAYS);
  assert.deepEqual(parseExpiryReminderDays("999999"), DEFAULT_EXPIRY_REMINDER_DAYS);
  // 混着脏数据时，能认的那些照常生效。
  assert.deepEqual(parseExpiryReminderDays("7,abc,1"), [7, 1]);
});

test("只在配置的那几天发，不是「三天内每天发一次」", () => {
  const days = [7, 3, 1];
  assert.equal(shouldSendExpiryReminder(7, days), true);
  assert.equal(shouldSendExpiryReminder(5, days), false, "第 5 天不该发，否则三封说同一件事");
  assert.equal(shouldSendExpiryReminder(3, days), true);
  assert.equal(shouldSendExpiryReminder(2, days), false);
  assert.equal(shouldSendExpiryReminder(1, days), true);
});

test("当天到期要发，已经过期不发", () => {
  // 剩 0 天是最后一次能救回来的机会；过期之后该做的是停服，不是发提醒。
  assert.equal(shouldSendExpiryReminder(0, [7, 3, 1, 0]), true);
  assert.equal(shouldSendExpiryReminder(0, [7, 3, 1]), false);
  assert.equal(shouldSendExpiryReminder(-1, [7, 3, 1, 0]), false);
  assert.equal(shouldSendExpiryReminder(Number.NaN, [7, 3, 1]), false);
});
