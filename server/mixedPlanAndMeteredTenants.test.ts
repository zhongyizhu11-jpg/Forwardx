import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 一个租户走套餐、另一个走按量计费，两种模式能不能同时跑。
 *
 * 能 —— 但**开关挂在资源上，不挂在人身上**。计费的分叉只看这条转发所属的
 * 转发组 / 隧道 / 主机有没有配价（见 agentReportRoutes 里那个 billingResource 分支），
 * 从头到尾没有读过「这个用户是套餐户还是计费户」，因为面板里根本没有这样一个字段。
 *
 * 所以两件事必须分清楚：
 *
 * 1. 两个租户各自用**不同的资源** → 两种模式并存，互不影响。这是正常配法。
 * 2. 两个租户的转发落在**同一个计费资源**上 → 两个都按量计费。想让其中一个走套餐，
 *    办法只有一个：把他的转发挪到没配价的资源上。
 *
 * 第 2 条在「整台主机兜底价」这个功能下特别容易踩：兜底价会把这台机器上**所有**
 * 没被单独计价的转发接管过去，包括套餐户的。而套餐户通常余额是 0 —— 余额 ≤ 0 会被
 * 直接停掉名下全部转发。这条用例把这个后果钉住，免得哪天有人以为兜底价只对计费户生效。
 */
test("套餐户和计费户能同时跑，但走的是资源不是人", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-mixed-billing-"));
  const databasePath = path.join(directory, "mixed.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import express from "express";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const billing = await import(url("server/repositories/trafficBillingRepository.ts"));
    const reports = await import(url("server/agentReportRoutes.ts"));

    const GB = 1024 ** 3;
    let server;
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, p = []) => runtime.executeRaw(sql, p);
      const query = (sql, p = []) => runtime.queryRaw(sql, p);

      // 套餐户：有流量额度，余额 0（买的是套餐，没充过钱）
      await exec("INSERT INTO users (id, username, password, role, trafficLimit, trafficUsed, balanceCents, canAddRules, accountEnabled) VALUES (2, '套餐户', 'h', 'user', ?, 0, 0, 1, 1)", [100 * GB]);
      // 计费户：没有额度，余额 100 元
      await exec("INSERT INTO users (id, username, password, role, trafficLimit, trafficUsed, balanceCents, canAddRules, accountEnabled) VALUES (3, '计费户', 'h', 'user', 0, 0, 10000, 1, 1)");

      await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId, isOnline) VALUES (10, '共用机', '127.0.0.10', 'slave', 'tok10', 1, 1)");
      await exec("INSERT INTO forward_groups (id, name, groupType, groupMode, targetIp, userId, isEnabled) VALUES (7, '计费组', 'host', 'port', '127.0.0.1', 1, 1)");

      const rule = (id, userId, groupId) => exec(
        "INSERT INTO forward_rules (id, hostId, name, sourcePort, targetIp, targetPort, userId, forwardGroupId, isEnabled, isRunning) VALUES (?, 10, ?, ?, '127.0.0.1', 8080, ?, ?, 1, 1)",
        [id, "rule" + id, 10000 + id, userId, groupId],
      );
      await rule(201, 2, null);   // 套餐户：不挂任何配了价的资源
      await rule(301, 3, 7);      // 计费户：挂在配了价的转发组上

      await billing.setTrafficBillingEnabled(true);
      await billing.upsertTrafficBillingConfig({
        resourceType: "forward_group", resourceId: 7, enabled: true, pricePerGbMilliCents: 100000, // ¥1/GB
      });

      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        const authorization = String(req.headers.authorization || "");
        req.agentToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        next();
      });
      reports.registerAgentReportRoutes(app);
      server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const baseUrl = "http://127.0.0.1:" + server.address().port;
      const report = async (reportId, stats) => {
        const response = await fetch(baseUrl + "/api/agent/traffic", {
          method: "POST",
          headers: { authorization: "Bearer tok10", "content-type": "application/json" },
          body: JSON.stringify({ reportId, reportProducerId: "p1", stats }),
        });
        assert.equal(response.status, 200);
      };
      const userRow = async (id) => (await query('SELECT "trafficUsed", "balanceCents", "canAddRules" FROM "users" WHERE "id" = ?', [id]))[0];
      const ruleEnabled = async (id) => Number((await query('SELECT "isEnabled" FROM "forward_rules" WHERE "id" = ?', [id]))[0].isEnabled) === 1;

      // === 场景一：各用各的资源 —— 两种模式并存，互不串台 ===
      await report("r1", [
        { ruleId: 201, bytesIn: 2 * GB, bytesOut: 0 },
        { ruleId: 301, bytesIn: 3 * GB, bytesOut: 0 },
      ]);

      const plan1 = await userRow(2);
      const metered1 = await userRow(3);
      assert.equal(Number(plan1.trafficUsed), 2 * GB, "套餐户的量要记进他的套餐额度");
      assert.equal(Number(plan1.balanceCents), 0, "套餐户一分钱都不该被扣");
      assert.equal(Number(metered1.trafficUsed), 0, "计费户的量不该再记进套餐额度 —— 两条路互斥");
      assert.equal(Number(metered1.balanceCents), 10000 - 300, "计费户按 ¥1/GB 扣 3GB");

      /*
        === 场景二：给整台机器配兜底价 ===

        这是「每台机器整台按量计费」那个功能。它会把这台机器上**所有**没被单独计价的
        转发接管过去 —— 套餐户那条也在内，因为分叉只看资源，不看人。

        套餐户余额是 0，而余额 ≤ 0 的处理是**停掉他名下全部转发**。
      */
      await billing.upsertTrafficBillingConfig({
        resourceType: "host", resourceId: 10, enabled: true, pricePerGbMilliCents: 100000,
      });
      await report("r2", [
        { ruleId: 201, bytesIn: 1 * GB, bytesOut: 0 },
        { ruleId: 301, bytesIn: 1 * GB, bytesOut: 0 },
      ]);

      const plan2 = await userRow(2);
      assert.equal(
        Number(plan2.trafficUsed),
        2 * GB,
        "兜底价一配，套餐户这条就不再记进套餐额度了 —— 他被接管到按量那条路上",
      );
      assert.equal(
        Number(plan2.canAddRules),
        0,
        "套餐户余额 0，被按量计费判定为余额不足，名下转发全停",
      );
      assert.equal(await ruleEnabled(201), false, "转发确实被停掉了，不只是标记");

      // 计费户不受影响：他本来就挂在转发组上，走的还是组价。
      const metered2 = await userRow(3);
      assert.equal(Number(metered2.balanceCents), 10000 - 300 - 100, "计费户继续按组价 ¥1/GB 扣");
      assert.equal(await ruleEnabled(301), true);

      /*
        收拾办法：把兜底价停掉，套餐户那条就回到套餐额度上。
        这也验证了「想让某个租户走套餐，办法是把他的转发挪到没配价的资源上」。
      */
      await billing.upsertTrafficBillingConfig({
        resourceType: "host", resourceId: 10, enabled: false, pricePerGbMilliCents: 100000,
      });
      await exec('UPDATE "users" SET "canAddRules" = 1 WHERE "id" = 2');
      await exec('UPDATE "forward_rules" SET "isEnabled" = 1 WHERE "id" = 201');
      await report("r3", [{ ruleId: 201, bytesIn: 1 * GB, bytesOut: 0 }]);
      const plan3 = await userRow(2);
      assert.equal(Number(plan3.trafficUsed), 3 * GB, "兜底价停掉，套餐户回到记额度那条路");
      assert.equal(Number(plan3.balanceCents), 0, "仍然一分钱不扣");

      console.log("MIXED_OK");
    } finally {
      if (server) await new Promise((resolve) => server.close(() => resolve()));
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, NODE_ENV: "test" },
      timeout: 120000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /MIXED_OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
