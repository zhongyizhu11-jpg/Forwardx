import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { authErrorMessage } from "./authErrorMessage";

test("rate-limit codes become Chinese messages with the wait time", () => {
  assert.equal(authErrorMessage("LOGIN_RATE_LIMITED:5"), "登录尝试过于频繁，请 5 分钟后重试");
  assert.equal(authErrorMessage("TWO_FACTOR_RATE_LIMITED:3"), "双重验证尝试过于频繁，请 3 分钟后重试");
  assert.equal(authErrorMessage("TWO_FACTOR_CHALLENGE_RATE_LIMITED:12"), "双重验证请求过于频繁，请 12 分钟后重试");
  assert.equal(authErrorMessage("TELEGRAM_LOGIN_RATE_LIMITED:1"), "Telegram 登录尝试过于频繁，请 1 分钟后重试");
  assert.equal(authErrorMessage("CAPTCHA_REFRESH_RATE_LIMITED:30"), "验证码刷新过于频繁，请 30 秒后重试");
  assert.equal(authErrorMessage("LOGIN_RATE_LIMITED:0"), "登录尝试过于频繁，请 1 分钟后重试");
});

test("plain codes are mapped and never shown raw", () => {
  for (const code of [
    "EMAIL_RATE_LIMITED",
    "CAPTCHA_REQUIRED",
    "CAPTCHA_REQUIRED_AFTER_FAIL",
    "CAPTCHA_INVALID",
    "CAPTCHA_CHALLENGE_UNAVAILABLE",
    "TELEGRAM_LOGIN_DISABLED",
    "TELEGRAM_NOT_BOUND",
    "TELEGRAM_WIDGET_REPLAYED",
    "TELEGRAM_WEBAPP_REPLAYED",
    "TELEGRAM_WEBAPP_CHALLENGE_INVALID",
    "TELEGRAM_WEBAPP_VERIFY_FAILED",
    "SETUP_LOCKED",
    "SETUP_MIGRATION_RUNNING",
  ]) {
    const text = authErrorMessage(code);
    assert.notEqual(text, code);
    assert.match(text, /[一-鿿]/, code);
    assert.doesNotMatch(text, /[A-Z]{2,}_[A-Z]/, code);
  }
});

test("unknown messages pass through and empty ones use the fallback", () => {
  assert.equal(authErrorMessage("用户名或密码错误"), "用户名或密码错误");
  assert.equal(authErrorMessage("", "登录失败"), "登录失败");
  assert.equal(authErrorMessage(undefined, "登录失败"), "登录失败");
  assert.equal(authErrorMessage({ message: "SETUP_LOCKED" }), authErrorMessage("SETUP_LOCKED"));
  assert.equal(authErrorMessage(" LOGIN_RATE_LIMITED:2 "), "登录尝试过于频繁，请 2 分钟后重试");
});

test("login, setup and 2FA toasts go through authErrorMessage", () => {
  const read = (file: string) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
  const login = read("../pages/Login.tsx");
  // 错误原文不能直接进 toast：要么是明确的中文分支，要么过 authErrorMessage。
  assert.doesNotMatch(login, /toast\.error\((?:error\.message|msg) \|\|/);
  assert.doesNotMatch(login, /TELEGRAM_LOGIN_RATE_LIMITED:\(/, "不再各处手写正则");
  const setup = read("../pages/Setup.tsx");
  assert.doesNotMatch(setup, /toast\.error\(error\.message \|\|/);
  for (const file of ["../pages/Profile.tsx", "../components/DashboardLayout.tsx"]) {
    const source = read(file);
    assert.match(source, /authErrorMessage\(error\.message, "启用双重验证失败"\)/, file);
    assert.match(source, /authErrorMessage\(error\.message, "关闭双重验证失败"\)/, file);
  }
});

test("Telegram link login keeps the page pending and the register form warns about http://", () => {
  const login = fs.readFileSync(new URL("../pages/Login.tsx", import.meta.url), "utf8");
  assert.match(login, /const isPending = [^;]*telegramLoginMutation\.isPending/);
  assert.match(login, /onSettled: \(\) => setTelegramLinkConfirming\(null\)/);
  const registerForm = login.slice(login.indexOf("<form onSubmit={handleRegister}"));
  assert.match(registerForm, /\{showInsecurePanelWarning && \(/);
});

test("every SCREAMING_CASE auth code the server throws has a mapping", () => {
  const sources = ["auth.ts", "telegram.ts", "setup.ts"].map((file) =>
    fs.readFileSync(new URL(`../../../server/routers/${file}`, import.meta.url), "utf8"),
  ).join("\n") + fs.readFileSync(new URL("../../../server/authCaptcha.ts", import.meta.url), "utf8");
  const codes = new Set<string>();
  for (const match of sources.matchAll(/(?:message: |new Error\()[`"']([A-Z][A-Z0-9_]{4,})(?::\$\{[^}]+\})?[`"']/g)) {
    codes.add(match[1]);
  }
  assert.ok(codes.size >= 10);
  for (const code of codes) {
    const sample = authErrorMessage(`${code}:2`) !== `${code}:2` ? `${code}:2` : code;
    assert.notEqual(authErrorMessage(sample), sample, `${code} is shown raw`);
  }
});
