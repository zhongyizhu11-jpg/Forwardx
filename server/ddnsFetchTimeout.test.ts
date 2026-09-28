import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { DDNS_REQUEST_TIMEOUT_MS, ddnsFetch } from "./ddns";

/**
 * DDNS 更新在转发组故障切换的按组加锁里做。服务商 API 卡住不回，这把锁就一直不放，
 * 这个组之后的健康检查、切换、恢复全排在它后面。所以每个请求都必须有超时。
 */
test("DNS 服务商 API 不回应时，请求按时超时并给出中文原因", async () => {
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer(() => { /* 永远不回 */ });
  server.on("connection", (socket) => sockets.add(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as import("node:net").AddressInfo;
  try {
    const startedAt = Date.now();
    await assert.rejects(
      ddnsFetch(`http://127.0.0.1:${port}/zones`, { method: "GET" }, 200),
      /DDNS 请求超时.*127\.0\.0\.1/,
    );
    assert.ok(Date.now() - startedAt < 5_000, "超时要按设定生效，而不是一直挂着");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.ok(DDNS_REQUEST_TIMEOUT_MS > 0 && DDNS_REQUEST_TIMEOUT_MS <= 30_000);
});

test("ddns.ts 里所有服务商请求都经过带超时的 ddnsFetch", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "ddns.ts"), "utf8");
  // 只允许 ddnsFetch 自己里面那一处裸 fetch。
  const bare = source.match(/(?<![A-Za-z_])fetch\(/g) || [];
  assert.equal(bare.length, 1, "新加的服务商请求请走 ddnsFetch，否则服务商卡住时会一直占着故障切换的锁");
  assert.ok((source.match(/ddnsFetch\(/g) || []).length >= 12);
});
