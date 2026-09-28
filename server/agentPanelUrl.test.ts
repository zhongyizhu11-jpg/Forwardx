import assert from "node:assert/strict";
import test from "node:test";
import express, { type Request } from "express";
import { normalizePanelUrl, resolveRequestPanelUrl } from "./agentPanelUrl";
import { resolveTrustProxySetting } from "./trustProxy";

// 用真实的 Express app 编译 trust proxy，和线上 index.ts 的判定完全一致（默认只信任 loopback）。
function appWithTrustProxy(value: unknown = "loopback") {
  const app = express();
  app.set("trust proxy", resolveTrustProxySetting(value));
  return app;
}

function request(
  headers: Record<string, string | string[] | undefined>,
  protocol = "http",
  remoteAddress = "127.0.0.1",
  app = appWithTrustProxy(),
) {
  return {
    app,
    headers,
    protocol,
    socket: { remoteAddress },
    get(name: string) {
      if (name.toLowerCase() === "host") return String(headers.host || "");
      return undefined;
    },
  } as unknown as Request;
}

test("configured panel URL is validated and keeps a base path", () => {
  assert.equal(normalizePanelUrl(" https://panel.example.com/forwardx/ "), "https://panel.example.com/forwardx");
  assert.equal(normalizePanelUrl("javascript:alert(1)"), "");
  assert.equal(normalizePanelUrl("https://user:pass@panel.example.com"), "");
  assert.equal(normalizePanelUrl("https://panel.example.com/?redirect=bad"), "");
});

test("request panel URL uses the first trusted proxy values", () => {
  const req = request({
    host: "127.0.0.1:9810",
    "x-forwarded-proto": "https, http",
    "x-forwarded-host": "panel.example.com, internal.local",
    "x-forwarded-port": "443",
    "x-forwarded-prefix": "/forwardx",
  });
  assert.equal(resolveRequestPanelUrl(req), "https://panel.example.com/forwardx");
});

test("request panel URL adds a non-default forwarded port", () => {
  const req = request({
    host: "internal:9810",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "panel.example.com",
    "x-forwarded-port": "8443",
  });
  assert.equal(resolveRequestPanelUrl(req), "https://panel.example.com:8443");
});

test("unsafe host and prefix values are ignored", () => {
  assert.equal(resolveRequestPanelUrl(request({ host: "panel.example.com/path" })), "");
  assert.equal(resolveRequestPanelUrl(request({ host: "panel.example.com", "x-forwarded-prefix": "/../admin" })), "http://panel.example.com");
});

test("forwarded headers from an untrusted peer are ignored", () => {
  const spoofed = {
    host: "panel.example.com:9810",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "evil.example.net",
    "x-forwarded-port": "443",
    "x-forwarded-prefix": "/phish",
    "cf-visitor": '{"scheme":"https"}',
  };
  // 默认 trust proxy=loopback：公网客户端直连时，转发头一律不认，只用直连 Host。
  assert.equal(resolveRequestPanelUrl(request(spoofed, "http", "203.0.113.9")), "http://panel.example.com:9810");
  // 关闭 trust proxy 时连 loopback 也不认。
  assert.equal(
    resolveRequestPanelUrl(request(spoofed, "http", "127.0.0.1", appWithTrustProxy("false"))),
    "http://panel.example.com:9810",
  );
  // 没有 app/对端信息的请求按不受信处理。
  const bare = { headers: spoofed, protocol: "http", get: (name: string) => (name.toLowerCase() === "host" ? spoofed.host : undefined) };
  assert.equal(resolveRequestPanelUrl(bare as unknown as Request), "http://panel.example.com:9810");
});

test("forwarded headers are honoured when the peer is a configured trusted proxy", () => {
  const headers = {
    host: "10.0.0.5:3000",
    "x-forwarded-host": "panel.example.com",
    "cf-visitor": '{"scheme":"https"}',
  };
  assert.equal(
    resolveRequestPanelUrl(request(headers, "http", "10.0.0.2", appWithTrustProxy("10.0.0.0/8"))),
    "https://panel.example.com",
  );
  assert.equal(
    resolveRequestPanelUrl(request(headers, "http", "198.51.100.2", appWithTrustProxy("10.0.0.0/8"))),
    "http://10.0.0.5:3000",
  );
});

test("a configured panel URL always wins over request headers", () => {
  const req = request({ host: "evil.example.net", "x-forwarded-host": "evil.example.net" }, "http", "203.0.113.9");
  assert.equal(resolveRequestPanelUrl(req, "https://panel.example.com/nex/"), "https://panel.example.com/nex");
});
