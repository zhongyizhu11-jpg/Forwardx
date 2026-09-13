import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 落地入站的流量算到谁头上。
 *
 * 上报走的是 Agent token，认的是**机器**；而入站号是连号的，猜得到。少了「这个入站
 * 是不是开在这台机器上」这一比，任何一台装了 Agent 的机器（包括租户自助加的那台）
 * 都能把字节数记到别的租户头上 —— 记满配额，面板就自动停掉那个人名下所有转发。
 * 转发那条路早就按 accountingHostIds 比过了，这一组是给落地这条路补上同样的比。
 */
test("SQLite 落地入站流量只认本机、只认启用中的入站，坏数值不进账", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-inbound-traffic-"));
  const databasePath = path.join(directory, "inbound-traffic.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import express from "express";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const reports = await import(url("server/agentReportRoutes.ts"));

    const INBOUND_BASE = 1000000000;
    let server;
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();

      await runtime.executeRaw(
        'INSERT INTO "users" ("id", "username", "password", "name", "role", "trafficUsed") VALUES (?, ?, ?, ?, ?, ?)',
        [1, "inbound-admin", "hash", "Admin", "admin", 0],
      );
      await runtime.executeRaw(
        'INSERT INTO "users" ("id", "username", "password", "name", "role", "trafficUsed") VALUES (?, ?, ?, ?, ?, ?)',
        [2, "inbound-victim", "hash", "Victim", "user", 0],
      );
      for (const hostId of [10, 20]) {
        await runtime.executeRaw(
          'INSERT INTO "hosts" ("id", "name", "ip", "hostType", "agentToken", "userId") VALUES (?, ?, ?, ?, ?, ?)',
          [hostId, "inbound-host-" + hostId, "127.0.0." + hostId, "slave", "inbound-token-" + hostId, 1],
        );
      }
      // 5：主机 10 上、启用中；6：主机 10 上、已停用。两个都属于用户 2。
      await runtime.executeRaw(
        'INSERT INTO "proxy_inbounds" ("id", "userId", "hostId", "name", "protocol", "port", "isEnabled") VALUES (?, ?, ?, ?, ?, ?, ?)',
        [5, 2, 10, "victim-inbound", "vless", 12345, 1],
      );
      await runtime.executeRaw(
        'INSERT INTO "proxy_inbounds" ("id", "userId", "hostId", "name", "protocol", "port", "isEnabled") VALUES (?, ?, ?, ?, ?, ?, ?)',
        [6, 2, 10, "disabled-inbound", "vless", 12346, 0],
      );

      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        const authorization = String(req.headers.authorization || "");
        req.agentToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        next();
      });
      reports.registerAgentReportRoutes(app);
      server = http.createServer(app);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const baseUrl = "http://127.0.0.1:" + server.address().port;

      async function report(hostId, reportId, stats) {
        const response = await fetch(baseUrl + "/api/agent/traffic", {
          method: "POST",
          headers: {
            authorization: "Bearer inbound-token-" + hostId,
            "content-type": "application/json",
          },
          body: JSON.stringify({ reportId, reportProducerId: "producer-" + hostId, stats }),
        });
        assert.equal(response.status, 200);
        return response.json();
      }
      async function victimUsed() {
        const rows = await runtime.queryRaw('SELECT "trafficUsed" FROM "users" WHERE "id" = 2', []);
        return Number(rows[0].trafficUsed);
      }

      await report(10, "own-1", [{ ruleId: INBOUND_BASE + 5, bytesIn: 600, bytesOut: 400 }]);
      assert.equal(await victimUsed(), 1000, "本机上报自己的入站要照常计费");

      await report(20, "spoof-1", [{ ruleId: INBOUND_BASE + 5, bytesIn: 500000, bytesOut: 0 }]);
      assert.equal(
        await victimUsed(),
        1000,
        "别的机器报这个入站号，一个字节都不能算到主人头上 —— 否则等于谁都能刷爆别人的配额",
      );

      await report(10, "disabled-1", [{ ruleId: INBOUND_BASE + 6, bytesIn: 7777, bytesOut: 0 }]);
      assert.equal(await victimUsed(), 1000, "停用的入站不该还在计费");

      await report(10, "ghost-1", [{ ruleId: INBOUND_BASE + 999, bytesIn: 3333, bytesOut: 0 }]);
      assert.equal(await victimUsed(), 1000, "不存在的入站号是无主流量，丢掉");

      await report(10, "negative-1", [{ ruleId: INBOUND_BASE + 5, bytesIn: -900, bytesOut: -100 }]);
      assert.equal(await victimUsed(), 1000, "负数上报不能把已用流量倒扣回去");

      await report(10, "huge-1", [{ ruleId: INBOUND_BASE + 5, bytesIn: 1e21, bytesOut: 0 }]);
      const afterHuge = await victimUsed();
      assert.equal(
        afterHuge,
        1000 + Number.MAX_SAFE_INTEGER,
        "天文数字要和入库那层截成同一个数，否则历史明细和配额对不上",
      );

      // 落地入站不写 traffic_stats（那张表按转发规则组织），只进配额。
      const statRows = await runtime.queryRaw('SELECT COUNT(*) AS "count" FROM "traffic_stats"', []);
      assert.equal(Number(statRows[0].count), 0, "落地入站的字节不该塞进按规则组织的明细表");
    } finally {
      if (server) await new Promise((resolve) => server.close(() => resolve()));
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 90_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
