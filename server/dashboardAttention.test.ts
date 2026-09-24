import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 首页「需要关注」和顶上那个异常数。
 *
 * 这一组盯三件事：
 *
 *   一、两类看着像「转发没在跑」、其实不是故障的，不能再算异常：
 *       转发组的模板规则（它自己从不运行，跑的是子规则），以及主人被暂停转发的
 *       规则（到期、超额、欠费 —— 计费把它停的，不是坏了）。
 *   二、列表里的每一行都对得上顶上的计数：同一组判据，逐类对应。
 *   三、每一类只取有限几行，但总数照实给 —— 「还有 N 项」靠它。
 */
function runScenario(script: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-attention-"));
  const databasePath = path.join(directory, "attention.db");
  const prelude = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const dash = await import(url("server/repositories/dashboardRepository.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);

    const fresh = Math.floor(Date.now() / 1000);
    const stale = fresh - 6 * 3600;

    const addUser = (id, role, canAddRules = 1, pauseReason = null) => exec(
      'INSERT INTO users (id, username, password, role, "canAddRules", "forwardAccessPauseReason") VALUES (?, ?, ?, ?, ?, ?)',
      [id, "u" + id, "hash", role, canAddRules, pauseReason],
    );
    const addHost = (id, owner, isOnline, heartbeat, name = "主机" + id) => exec(
      'INSERT INTO hosts (id, name, ip, "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, name, "203.0.113." + id, "tok" + id, owner, isOnline, heartbeat],
    );
    const addRule = (id, host, owner, enabled, running, extra = {}) => exec(
      'INSERT INTO forward_rules (id, "hostId", name, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning",'
        + ' "forwardGroupId", "forwardGroupRuleId", "isForwardGroupTemplate", "pendingDelete")'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, host, extra.name || "转发" + id, 8000 + id, "198.51.100.1", 80, owner, enabled, running,
        extra.groupId ?? null, extra.parent ?? null, extra.template ? 1 : 0, extra.pendingDelete ? 1 : 0],
    );
    const addTunnel = (id, name, entry, exit, enabled, running, owner = 1) => exec(
      'INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", "listenPort", "userId", "isEnabled", "isRunning")'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, name, entry, exit, 9000 + id, owner, enabled, running],
    );
    const addGroup = (id, status, extra = {}) => exec(
      'INSERT INTO forward_groups (id, name, "targetIp", "userId", "isEnabled", "lastStatus", "lastMessage", "groupMode")'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, extra.name || "组" + id, "198.51.100.9", extra.owner ?? 1, extra.enabled ?? 1, status, extra.message ?? null, extra.mode || "failover"],
    );
    const reasons = (health) => health.attention.rows.map((row) => row.reason + ":" + row.id).sort();
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", prelude + script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /OK/);
}

test("转发组模板看子规则：有子规则在跑就是在跑，一条都没在跑才算异常", () => {
  runScenario(String.raw`
    await addUser(1, "admin");
    await addHost(10, 1, 1, fresh);
    await addGroup(30, "healthy", { name: "游戏主备" });
    await addGroup(31, "healthy", { name: "API 主备" });

    // 模板自己的 isRunning 永远是 0 —— 它从不下发给 Agent。
    await addRule(1, 10, 1, 1, 0, { template: true, groupId: 30, name: "游戏模板" });
    await addRule(2, 10, 1, 1, 1, { groupId: 30, parent: 1 });   // 子规则在跑
    await addRule(3, 10, 1, 1, 0, { template: true, groupId: 31, name: "API 模板" });
    await addRule(4, 10, 1, 1, 0, { groupId: 31, parent: 3 });   // 子规则也没在跑
    await addRule(5, 10, 1, 1, 1, { groupId: 31, parent: 3, pendingDelete: true }); // 正在删的不算数

    const health = await dash.getDashboardHealth(undefined);
    assert.equal(health.forwards.total, 2, "子规则不计入总数 —— 界面上一个转发组只显示一条");
    assert.equal(health.forwards.running, 1, "有子规则在跑的模板就是在跑");
    assert.equal(
      health.forwards.stalled,
      1,
      "只有一条子规则都没在跑的模板才算没在跑；上一版每个启用的转发组都会在这里多记一条，永远消不掉",
    );
    assert.deepEqual(reasons(health), ["forward-stalled:3"]);
    const row = health.attention.rows[0];
    assert.equal(row.groupName, "API 主备", "模板该说它属于哪个转发组 —— 它在哪台机器上没有意义，它不跑");
    assert.equal(row.hostName, null);
    assert.equal(health.issues, 1);
    console.log("OK");
  `);
});

test("主人被暂停转发的规则：管理员那边不算异常，租户自己那边合成一行说清原因", () => {
  runScenario(String.raw`
    await addUser(1, "admin");
    await addUser(2, "user", 0, "expired");   // 到期，转发被暂停
    await addUser(3, "user", 1);              // 正常租户
    await addHost(10, 1, 1, fresh);

    // 计费停掉的规则：isEnabled 还是 1（续期后要自己恢复），isRunning 被清成 0。
    await addRule(1, 10, 2, 1, 0);
    await addRule(2, 10, 2, 1, 0);
    await addRule(3, 10, 3, 1, 0);   // 正常租户的规则没在跑 —— 这才是真的异常
    await addRule(4, 10, 1, 1, 0);   // 管理员自己的规则没在跑

    const admin = await dash.getDashboardHealth(undefined);
    assert.equal(admin.forwards.paused, 2);
    assert.equal(
      admin.forwards.stalled,
      2,
      "到期租户那两条是计费停的，不是坏了；算进来的话每个没续费的租户都在管理员首页挂一条红的",
    );
    assert.equal(admin.attention.totals["forward-paused"], 0, "暂停是计费状态，不是管理员要处理的系统故障");
    assert.deepEqual(reasons(admin), ["forward-stalled:3", "forward-stalled:4"]);
    assert.equal(admin.issues, 2);

    const tenant = await dash.getDashboardHealth(2);
    assert.equal(tenant.forwards.stalled, 0);
    assert.equal(tenant.forwards.paused, 2);
    assert.equal(tenant.attention.totals["forward-paused"], 1, "十条一起停，原因只有一个 —— 合成一行，不刷屏");
    const paused = tenant.attention.rows.find((row) => row.reason === "forward-paused");
    assert.ok(paused, "租户自己的首页上必须看得到转发停了");
    assert.equal(paused.count, 2);
    assert.equal(paused.pauseReason, "expired");
    assert.equal(tenant.issues, 1, "对租户来说转发确实停了，这是一件要他处理的事");

    const other = await dash.getDashboardHealth(3);
    assert.equal(other.attention.totals["forward-paused"], 0, "没被暂停的租户不该看到这一行");
    assert.deepEqual(reasons(other), ["forward-stalled:3"]);
    console.log("OK");
  `);
});

test("各类行和顶上的计数逐类对应，上下文带得出来", () => {
  runScenario(String.raw`
    await addUser(1, "admin");
    await addHost(10, 1, 1, fresh, "HK entry");
    await addHost(11, 1, 1, stale, "US backup");   // 掉线
    await addHost(12, 1, 0, null, "新机器");        // 还没接入

    await addTunnel(20, "HK → US", 10, 11, 1, 0);   // 没在运行
    await addTunnel(21, "停用的隧道", 10, 11, 0, 0); // 停用的不算
    await addTunnel(22, "好隧道", 10, 11, 1, 1);

    await addGroup(30, "down", { name: "坏组", message: "所有成员都探不通", mode: "chain" });
    await addGroup(31, "error", { name: "错组" });
    await addGroup(32, "degraded", { name: "降级组", message: "备线离线", mode: "exit" });
    await addGroup(33, "unknown", { name: "没测过的组" });
    await addGroup(34, "down", { name: "停用的坏组", enabled: 0 });

    await addRule(1, 11, 1, 1, 0, { name: "掉线机器上的转发" });

    const health = await dash.getDashboardHealth(undefined);
    const totals = health.attention.totals;
    assert.equal(totals["host-offline"], 1);
    assert.equal(totals["host-never-connected"], 1);
    assert.equal(totals["tunnel-stopped"], 1);
    assert.equal(totals["group-down"], 2, "down 和 error 都算故障");
    assert.equal(totals["group-degraded"], 1);
    assert.equal(totals["forward-stalled"], 1);
    assert.equal(health.links.degraded, 1);
    assert.equal(health.links.unhealthy, 3);
    assert.equal(health.links.healthy, 8 - 3 - 1);

    assert.equal(
      health.issues,
      1 + 1 + 2 + 1,
      "异常 = 掉线主机 + 没在运行的隧道 + 故障转发组 + 没在跑的转发；还没接入和降级不算异常",
    );

    for (const [reason, total] of Object.entries(totals)) {
      const count = health.attention.rows.filter((row) => row.reason === reason).length;
      assert.equal(count, total, reason + " 的行数必须和计数对得上");
    }

    const byReason = (reason) => health.attention.rows.filter((row) => row.reason === reason);
    const offline = byReason("host-offline")[0];
    assert.equal(offline.name, "US backup");
    assert.ok(Math.abs(offline.at - stale * 1000) < 2000, "掉线主机要带最后一次心跳，界面才写得出「最后在线 6 小时前」");

    const tunnel = byReason("tunnel-stopped")[0];
    assert.equal(tunnel.entryName, "HK entry");
    assert.equal(tunnel.exitName, "US backup", "隧道那一行带出入口/出口，一眼就对得上上面那台掉线的机器");

    const down = byReason("group-down").find((row) => row.id === 30);
    assert.equal(down.message, "所有成员都探不通");
    assert.equal(down.groupMode, "chain", "转发组的形态要带回去，点进去才落得到链路页对应的 tab");

    const stalled = byReason("forward-stalled")[0];
    assert.equal(stalled.hostName, "US backup");

    assert.ok(!health.attention.rows.some((row) => row.name === "没测过的组"), "unknown 的转发组是还没测过，不是出事了");
    assert.ok(!health.attention.rows.some((row) => row.name === "停用的坏组"), "停用的转发组是人主动关的");
    console.log("OK");
  `);
});

test("每一类只取有限几行，总数照实给；一切正常时一行都没有", () => {
  runScenario(String.raw`
    await addUser(1, "admin");
    await addUser(2, "user", 1);
    for (let i = 0; i < 9; i += 1) await addHost(100 + i, 1, 1, stale - i * 60, "掉线" + i);
    await addHost(200, 2, 1, stale, "租户的掉线机器");

    const admin = await dash.getDashboardHealth(undefined);
    assert.equal(admin.attention.totals["host-offline"], 10);
    const rows = admin.attention.rows.filter((row) => row.reason === "host-offline");
    assert.ok(rows.length > 0 && rows.length < 10, "首页只画几行，没必要把整表拉回来");
    assert.equal(rows[0].name, "掉线0", "刚掉的排在前面：掉了三天的那台多半已经有人知道了");

    const tenant = await dash.getDashboardHealth(2);
    assert.deepEqual(reasons(tenant), ["host-offline:200"], "租户只看自己的，别人的故障不该出现在他的首页上");

    await exec('UPDATE hosts SET "lastHeartbeat" = ?', [fresh]);
    const healthy = await dash.getDashboardHealth(undefined);
    assert.equal(healthy.issues, 0);
    assert.deepEqual(healthy.attention.rows, [], "都好了之后列表清空，否则首页永远挂着一块");
    console.log("OK");
  `);
});
