import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("订阅地址按 token 返回节点，并按客户端 UA 选择格式", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-proxy-sub-route-"));
  const databasePath = path.join(directory, "sub-route.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import express from "express";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const route = await import(url("server/proxySubscriptionRoute.ts"));
    const proxyNode = await import(url("shared/proxyNode.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();

    const exec = (sql, params = []) => runtime.executeRaw(sql, params);

    await exec("INSERT INTO users (id, username, password, role, trafficUsed, trafficLimit) VALUES (1, 'owner', 'hash', 'user', 12345, 1000000)");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'other', 'hash', 'user')");
    await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (1, '广州1', '1.2.3.4', '1.2.3.4', 1)");
    await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (2, '广州2', '5.6.7.8', '5.6.7.8', 1)");

    await exec(
      "INSERT INTO proxy_nodes (id, userId, name, protocol, address, port, uuid, transport, path, tls, sni, isEnabled) VALUES (1, 1, 'HKT', 'vless', 'hkt.example.com', 443, 'abc-uuid', 'ws', '/ray', 1, 'hkt.example.com', 1)",
    );

    const insertRule = (id, hostId, name, port, nodeId, visible) => exec(
      "INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, isEnabled, isRunning, pendingDelete, proxyNodeId, proxyNodeVisible) VALUES (?, ?, ?, 'realm', 'tcp', ?, 'hkt.example.com', 443, 1, 1, 1, 0, ?, ?)",
      [id, hostId, name, port, nodeId, visible],
    );
    await insertRule(1, 1, '广州1转HKT', 20001, 1, 1);
    await insertRule(2, 2, '广州2转HKT', 20002, 1, 1);
    await insertRule(3, 1, '隐藏的那条', 20003, 1, 0);
    await insertRule(4, 1, '未绑定的转发', 20004, null, 1);

    await exec("INSERT INTO proxy_sub_tokens (id, userId, name, token, defaultFormat, isEnabled) VALUES (1, 1, '手机', 'token-live', 'base64', 1)");
    await exec("INSERT INTO proxy_sub_tokens (id, userId, name, token, defaultFormat, isEnabled) VALUES (2, 1, '停用的', 'token-off', 'base64', 0)");

    const app = express();
    app.use(route.proxySubscriptionRouter);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const get = (pathname, headers = {}) => new Promise((resolve, reject) => {
      const request = http.request(
        { host: "127.0.0.1", port, path: pathname, method: "GET", headers },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { body += chunk; });
          response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
        },
      );
      request.on("error", reject);
      request.end();
    });

    // 默认格式：base64，解码后每行一个节点。
    const base64 = await get("/api/sub/token-live");
    assert.equal(base64.status, 200);
    const links = proxyNode.decodeBase64Utf8(base64.body).split("\n").filter(Boolean);
    assert.equal(links.length, 2, "隐藏和未绑定的转发不该进订阅，实际: " + links.join(" | "));
    assert.ok(links[0].includes("@1.2.3.4:20001"), links[0]);
    assert.ok(links[1].includes("@5.6.7.8:20002"), links[1]);
    // 凭据来自模板而不是转发规则。
    assert.ok(links[0].includes("abc-uuid"), links[0]);
    assert.ok(links[0].includes("sni=hkt.example.com"), links[0]);

    // 流量信息头，客户端据此显示已用流量与到期。
    assert.equal(base64.headers["subscription-userinfo"], "upload=0; download=12345; total=1000000; expire=0");
    assert.equal(base64.headers["cache-control"], "no-store");

    // UA 识别：Clash 拿到 YAML，sing-box 拿到 JSON，Loon 拿到节点行。
    const clash = await get("/api/sub/token-live", { "user-agent": "clash-verge/1.5.0" });
    assert.ok(clash.body.startsWith("proxies:"), clash.body.slice(0, 60));
    assert.ok(clash.headers["content-type"].includes("yaml"));

    const singbox = await get("/api/sub/token-live", { "user-agent": "sing-box 1.9.0" });
    assert.equal(JSON.parse(singbox.body).outbounds[0].type, "selector");

    const loon = await get("/api/sub/token-live", { "user-agent": "Loon/700" });
    assert.ok(loon.body.includes("= VLESS,1.2.3.4,20001,"), loon.body.slice(0, 120));

    // 显式 format 参数优先于 UA。
    const forced = await get("/api/sub/token-live?format=clash", { "user-agent": "Loon/700" });
    assert.ok(forced.body.startsWith("proxies:"));

    // 无效令牌与被停用的令牌都返回 404，不泄露令牌是否存在。
    assert.equal((await get("/api/sub/does-not-exist")).status, 404);
    assert.equal((await get("/api/sub/token-off")).status, 404);

    // 访问会被记录下来，便于用户发现订阅地址被别人用了。
    await new Promise((resolve) => setTimeout(resolve, 150));
    const rows = await runtime.queryRaw("SELECT accessCount, lastAccessUserAgent FROM proxy_sub_tokens WHERE id = 1");
    assert.ok(Number(rows[0].accessCount) >= 5, "访问次数未累加: " + rows[0].accessCount);

    await new Promise((resolve) => server.close(resolve));
    console.log("ok");
  `;

  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /ok/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("订阅只包含令牌所属用户的节点", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-proxy-sub-scope-"));
  const databasePath = path.join(directory, "sub-scope.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import express from "express";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const route = await import(url("server/proxySubscriptionRoute.ts"));
    const proxyNode = await import(url("shared/proxyNode.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'alice', 'hash', 'user')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'bob', 'hash', 'user')");
    await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (1, '共享入口', '1.2.3.4', '1.2.3.4', 1)");

    await exec("INSERT INTO proxy_nodes (id, userId, name, protocol, address, port, uuid, transport, tls, isEnabled) VALUES (1, 1, 'Alice 落地', 'vless', 'a.example.com', 443, 'alice-uuid', 'tcp', 1, 1)");
    await exec("INSERT INTO proxy_nodes (id, userId, name, protocol, address, port, uuid, transport, tls, isEnabled) VALUES (2, 2, 'Bob 落地', 'vless', 'b.example.com', 443, 'bob-uuid', 'tcp', 1, 1)");

    const insertRule = (id, userId, port, nodeId) => exec(
      "INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, isEnabled, isRunning, pendingDelete, proxyNodeId, proxyNodeVisible) VALUES (?, 1, 'rule', 'realm', 'tcp', ?, 'x.example.com', 443, ?, 1, 1, 0, ?, 1)",
      [id, port, userId, nodeId],
    );
    await insertRule(1, 1, 20001, 1);
    await insertRule(2, 2, 20002, 2);

    await exec("INSERT INTO proxy_sub_tokens (id, userId, name, token, defaultFormat, isEnabled) VALUES (1, 1, 'alice', 'alice-token', 'base64', 1)");

    const app = express();
    app.use(route.proxySubscriptionRouter);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const body = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/api/sub/alice-token" }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => resolve(text));
      }).on("error", reject);
    });

    const links = proxyNode.decodeBase64Utf8(body).split("\n").filter(Boolean);
    assert.equal(links.length, 1, "越权拿到了别人的节点: " + links.join(" | "));
    assert.ok(links[0].includes("alice-uuid"), links[0]);
    assert.ok(!links[0].includes("bob-uuid"), links[0]);

    await new Promise((resolve) => server.close(resolve));
    console.log("ok");
  `;

  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /ok/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
