import assert from "node:assert/strict";
import test from "node:test";
import { ipRateLimitScope } from "./ipRateLimitScope";
import { AuthCaptchaService, LOGIN_CAPTCHA_ACCOUNT_FAILURE_THRESHOLD } from "./authCaptcha";

test("IPv6 sources are grouped by /64, IPv4 stays per address", () => {
  assert.equal(ipRateLimitScope("2001:db8:1:2::1"), ipRateLimitScope("2001:db8:1:2:ffff:ffff:ffff:ffff"));
  assert.notEqual(ipRateLimitScope("2001:db8:1:2::1"), ipRateLimitScope("2001:db8:1:3::1"));
  assert.equal(ipRateLimitScope("2001:DB8:0001:0002::1"), "2001:db8:1:2::/64");
  assert.equal(ipRateLimitScope("::ffff:198.51.100.7"), "198.51.100.7");
  assert.equal(ipRateLimitScope("198.51.100.7"), "198.51.100.7");
  assert.equal(ipRateLimitScope(""), "unknown");
});

test("an account attacked from many sources requires a captcha, without locking it", () => {
  const captcha = new AuthCaptchaService();
  for (let i = 0; i < LOGIN_CAPTCHA_ACCOUNT_FAILURE_THRESHOLD; i += 1) {
    // 每次换一个来源，按「IP + 账户」算永远只有 1 次失败。
    captcha.recordLoginFailure(`198.51.100.${i + 1}`, "admin");
  }
  assert.equal(captcha.requiresLoginCaptcha("203.0.113.9", "admin"), true, "a brand-new source must also get the captcha");
  assert.equal(captcha.requiresLoginCaptcha("203.0.113.9", "someone-else"), false);
  captcha.clearLoginCaptchaRequirement("203.0.113.9", "admin");
  assert.equal(captcha.requiresLoginCaptcha("203.0.113.10", "admin"), false, "a successful login clears the account counter");
});
