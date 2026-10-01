import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 主机列表一页的实时数据合成了一个请求（hosts.pageLive）：状态、累计流量、最新指标一次拿齐，
 * 顺带续上「正在看」。范围按列表同一套可见性算：租户夹带别人的机器 id，只是被略过，
 * 不会整个报错，也不会把别人机器的数据带回来。
 */
test("hosts.pageLive 一次返回状态 / 流量 / 指标，只含看得见的机器", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-page-live-"));
  const databasePath = path.join(directory, "page-live.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const { hostsRouter } = await import(url("server/routers/hosts.ts"));
    const agentEvents = await import(url("server/agentEvents.ts"));

    const callerFor = (user) => hostsRouter.createCaller({
      req: { headers: {} },
      res: { clearCookie() {} },
      user,
      authSession: null,
      authFailureReason: null,
    });
    const admin = { id: 1, username: "admin", role: "admin", accountEnabled: true };
    const tenant = { id: 2, username: "tenant", role: "user", accountEnabled: true };

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, p = []) => runtime.executeRaw(sql, p);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'tenant', 'hash', 'user')");
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId, isOnline) VALUES (10, '租户的', '127.0.0.10', 'slave', 'tok10', 2, 1)");
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId, isOnline) VALUES (20, '管理员的', '127.0.0.20', 'slave', 'tok20', 1, 0)");
    const now = Math.floor(Date.now() / 1000);
    await exec("INSERT INTO host_metrics (hostId, cpuUsage, networkIn, networkOut, recordedAt) VALUES (10, 42, 100, 200, ?)", [now]);
    await exec("INSERT INTO host_metrics (hostId, cpuUsage, networkIn, networkOut, recordedAt) VALUES (20, 7, 1, 2, ?)", [now]);

    const empty = await callerFor(admin).pageLive({ hostIds: [] });
    assert.deepEqual(empty, { status: [], traffic: [], metrics: [] });

    const adminLive = await callerFor(admin).pageLive({ hostIds: [20, 10] });
    assert.deepEqual(adminLive.status.map((row) => row.id).sort((a, b) => a - b), [10, 20]);
    assert.equal(adminLive.metrics.find((row) => row.hostId === 10).cpuUsage, 42);
    assert.ok(Array.isArray(adminLive.traffic));
    assert.equal(agentEvents.isHostMetricsWatching(10), false, "没带 watch 不续「正在看」");

    // 租户夹带管理员的 20：略过，不报错、不泄露。
    const tenantLive = await callerFor(tenant).pageLive({ hostIds: [10, 20], watch: true });
    assert.deepEqual(tenantLive.status.map((row) => row.id), [10]);
    assert.deepEqual(tenantLive.metrics.map((row) => row.hostId), [10]);
    assert.ok(tenantLive.traffic.every((row) => row.hostId === 10));
    assert.equal(agentEvents.isHostMetricsWatching(10), true, "watch: true 续上「正在看」");
    assert.equal(agentEvents.isHostMetricsWatching(20), false);

    console.log("PAGE_LIVE_OK");
    process.exit(0);
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, NODE_ENV: "test" },
      timeout: 120000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PAGE_LIVE_OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
