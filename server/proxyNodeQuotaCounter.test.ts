import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 落地机已用流量的累计列。
 *
 * 为什么必须单独存一列：traffic_stats 只保留 72 小时，过期行会被清掉。
 * 要显示「这个套餐周期用了 367G」就只能有一个不会被清的累计值 ——
 * 事后拿 traffic_stats 求和是算不回来的。
 */
function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-node-quota-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      const repo = await import(url("server/repositories/proxySubscriptionRepository.ts"));

      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      const query = (sql, params = []) => runtime.queryRaw(sql, params);

      await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (1, 'alice', 'hash', 'user', 1)");
      const addNode = (id, name) => exec(
        "INSERT INTO proxy_nodes (id, userId, name, protocol, address, port, isEnabled) VALUES (?, 1, ?, 'vless', 'x.example.com', 443, 1)",
        [id, name],
      );
      const usedOf = async (id) => Number((await query("SELECT trafficUsed FROM proxy_nodes WHERE id = ?", [id]))[0].trafficUsed);

      ${body}

      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "quota.db") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("已用流量逐批累加，不是覆盖", () => {
  // 上报是增量，写成覆盖的话用量永远等于最后一批的大小。
  runInDatabase(String.raw`
    await addNode(1, "HKT");
    await repo.addProxyNodeTraffic(new Map([[1, 1000]]));
    assert.equal(await usedOf(1), 1000);
    await repo.addProxyNodeTraffic(new Map([[1, 2500]]));
    assert.equal(await usedOf(1), 3500);
  `);
});

test("一批里多个节点各算各的", () => {
  runInDatabase(String.raw`
    await addNode(1, "HKT");
    await addNode(2, "SG");
    await repo.addProxyNodeTraffic(new Map([[1, 100], [2, 900]]));
    assert.equal(await usedOf(1), 100);
    assert.equal(await usedOf(2), 900);
  `);
});

test("非法 id 与非正数增量被忽略，不会污染别人的用量", () => {
  runInDatabase(String.raw`
    await addNode(1, "HKT");
    await repo.addProxyNodeTraffic(new Map([[1, 500]]));
    await repo.addProxyNodeTraffic(new Map([[0, 999], [-3, 999], [1, 0], [1, -50], [999, 999]]));
    assert.equal(await usedOf(1), 500);
    // 空表直接返回，不该抛错。
    await repo.addProxyNodeTraffic(new Map());
    assert.equal(await usedOf(1), 500);
  `);
});

test("手工校准会覆盖累计值，之后继续累加", () => {
  // 跟机房账单对齐的场景：填一个数进去，后面的上报仍然往上加。
  runInDatabase(String.raw`
    await addNode(1, "HKT");
    await repo.addProxyNodeTraffic(new Map([[1, 1000]]));
    await repo.setProxyNodeTrafficUsed(1, 367_000_000_000);
    assert.equal(await usedOf(1), 367_000_000_000);
    await repo.addProxyNodeTraffic(new Map([[1, 1_000_000]]));
    assert.equal(await usedOf(1), 367_001_000_000);
  `);
});

test("校准填负数按 0 算", () => {
  runInDatabase(String.raw`
    await addNode(1, "HKT");
    await repo.setProxyNodeTrafficUsed(1, -5);
    assert.equal(await usedOf(1), 0);
  `);
});

test("清零会记下重置时间，月度任务靠它判断本周期是否已经重置过", () => {
  /**
   * 不记时间的话，每小时跑一次的调度任务会在重置日当天清零二十几次 ——
   * 那一天的用量会一直归零，看上去像统计坏了。
   */
  runInDatabase(String.raw`
    await addNode(1, "HKT");
    await repo.addProxyNodeTraffic(new Map([[1, 12345]]));
    await repo.resetProxyNodeTraffic(1);
    assert.equal(await usedOf(1), 0);
    const row = (await query("SELECT lastTrafficReset FROM proxy_nodes WHERE id = 1"))[0];
    assert.ok(Number(row.lastTrafficReset) > 0, "清零后应记下重置时间");
  `);
});

test("只挑开了自动重置且已到重置日的节点", () => {
  runInDatabase(String.raw`
    await addNode(1, "到日子了");
    await addNode(2, "还没到");
    await addNode(3, "没开自动重置");
    await exec("UPDATE proxy_nodes SET trafficAutoReset = 1, trafficResetDay = 1 WHERE id = 1");
    await exec("UPDATE proxy_nodes SET trafficAutoReset = 1, trafficResetDay = 28 WHERE id = 2");
    await exec("UPDATE proxy_nodes SET trafficAutoReset = 0, trafficResetDay = 1 WHERE id = 3");

    // 当月 15 号：1 号那个该重置，28 号那个还没到，没开开关的一律不动。
    const due = await repo.getProxyNodesForTrafficAutoReset(new Date(2026, 0, 15));
    assert.deepEqual(due.map((row) => Number(row.id)), [1]);

    // 月底：28 号那个也到了。
    const endOfMonth = await repo.getProxyNodesForTrafficAutoReset(new Date(2026, 0, 28));
    assert.deepEqual(endOfMonth.map((row) => Number(row.id)).sort(), [1, 2]);
  `);
});

test("新建节点的套餐字段默认是 0，不会凭空显示一个限额", () => {
  runInDatabase(String.raw`
    await addNode(1, "HKT");
    const row = (await query("SELECT bandwidthMbps, trafficLimit, trafficUsed, trafficAutoReset FROM proxy_nodes WHERE id = 1"))[0];
    assert.equal(Number(row.bandwidthMbps), 0);
    assert.equal(Number(row.trafficLimit), 0);
    assert.equal(Number(row.trafficUsed), 0);
    assert.equal(Number(row.trafficAutoReset), 0);
  `);
});
