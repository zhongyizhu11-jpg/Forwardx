import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 主机卡片上「几条转发 / 几条隧道」那两个数得是真的。
 *
 * 转发按 hostId 数，不看启用状态；隧道按入口 / 出口 / 多级隧道的任一跳算 —— 跳存在
 * tunnel_hops 表里（一跳一行），所以同一条隧道里一台机器既是入口又是某一跳时只能
 * 算一次，否则「在 2 条隧道里」会被报成 3。
 */
test("主机列表要带上每台机器的转发数和隧道数", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-counts-"));
  const databasePath = path.join(directory, "host-counts.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const rules = await import(url("server/repositories/forwardRuleRepository.ts"));
    const tunnels = await import(url("server/repositories/tunnelRepository.ts"));
    const { hostsRouter } = await import(url("server/routers/hosts.ts"));

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
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (10, '入口机', '127.0.0.10', 'slave', 'tok10', 2)");
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (20, '出口机', '127.0.0.20', 'slave', 'tok20', 2)");
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (30, '中转机', '127.0.0.30', 'slave', 'tok30', 2)");
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (40, '落地机', '127.0.0.40', 'slave', 'tok40', 2)");

    // 隧道 8：普通隧道 10 → 20。
    await exec("INSERT INTO tunnels (id, name, entryHostId, exitHostId, listenPort, userId) VALUES (8, '普通隧道', 10, 20, 9000, 2)");
    // 隧道 9：多级隧道 10 → 30 → 40，跳存在 tunnel_hops 里；入口 10 和出口 40 也各是一跳。
    await exec("INSERT INTO tunnels (id, name, entryHostId, exitHostId, listenPort, userId) VALUES (9, '多级隧道', 10, 40, 9001, 2)");
    await exec("INSERT INTO tunnel_hops (tunnelId, seq, hostId, listenPort) VALUES (9, 0, 10, 0)");
    await exec("INSERT INTO tunnel_hops (tunnelId, seq, hostId, listenPort) VALUES (9, 1, 30, 9101)");
    await exec("INSERT INTO tunnel_hops (tunnelId, seq, hostId, listenPort) VALUES (9, 2, 40, 9102)");

    const rule = (id, hostId, extra = {}) => exec(
      "INSERT INTO forward_rules (id, hostId, name, sourcePort, targetIp, targetPort, userId, isEnabled) VALUES (?, ?, ?, ?, '127.0.0.1', 8080, 2, ?)",
      [id, hostId, "rule" + id, 10000 + id, extra.disabled ? 0 : 1],
    );
    await rule(101, 10);
    await rule(301, 30);
    await rule(302, 30, { disabled: true }); // 停用的也算「挂在这台上」

    // 仓库层：一次 GROUP BY 查整页。
    const ruleCounts = await rules.countForwardRulesByHostIds([10, 20, 30, 40]);
    assert.deepEqual([...ruleCounts].sort((a, b) => a[0] - b[0]), [[10, 1], [30, 2]], "没有转发的主机不出现，停用的照样算");
    const tunnelCounts = await tunnels.countTunnelsByHostIds([10, 20, 30, 40]);
    assert.deepEqual(
      [...tunnelCounts].sort((a, b) => a[0] - b[0]),
      [[10, 2], [20, 1], [30, 1], [40, 1]],
      "入口 / 出口 / 任一跳都算；同一条隧道里既是入口又是一跳只算一次",
    );
    assert.equal((await tunnels.countTunnelsByHostIds([])).size, 0);
    assert.equal((await rules.countForwardRulesByHostIds([])).size, 0);

    // 路由层：每一行都带 ruleCount / tunnelCount，没有的是 0 而不是 undefined。
    const pageFor = async (user) => {
      const page = await callerFor(user).listPage({ cursor: 0, limit: 50 });
      return new Map(page.items.map((item) => [Number(item.id), item]));
    };
    let rows = await pageFor(admin);
    assert.equal(rows.size, 4);
    assert.deepEqual(
      [...rows.values()].map((row) => [Number(row.id), row.ruleCount, row.tunnelCount]).sort((a, b) => a[0] - b[0]),
      [[10, 1, 2], [20, 0, 1], [30, 2, 1], [40, 0, 1]],
    );
    assert.equal(rows.get(30).ruleCount, 2, "两条转发（含一条停用的）");
    assert.equal(rows.get(30).tunnelCount, 1, "只作为中转跳出现在一条隧道里");

    // 租户看自己的机器，数字一样 —— 只是个数，不透露别人的东西。
    rows = await pageFor(tenant);
    assert.equal(rows.get(30).ruleCount, 2);
    assert.equal(rows.get(30).tunnelCount, 1);
    assert.equal(rows.get(10).tunnelCount, 2);

    console.log("HOST_COUNTS_OK");
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, NODE_ENV: "test" },
      timeout: 120000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /HOST_COUNTS_OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
