import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 自建的落地端口跑了多少，得有人记。
 *
 * 原来只记到租户的套餐配额上，端口自己的已用量永远是 0 —— 于是「这台落地机的套餐」
 * 那一整套（额度、到量提醒）对自建的端口完全不响。而自建的那台机器恰恰才是商家
 * 自己买的、有机房账单、超量会被停机的那一个；粘贴进来的通常是别人家的，他反而管不着。
 *
 * 记在**入站**上而不是派生节点上：Agent 的计数链装在监听端口上，一个多用户入站派生出
 * 好几个节点、共用这一个端口，上报回来的字节数分不到人头（sing-box 官方二进制没有
 * per-user 统计）。所以「跑了多少」天然是端口的属性。
 */
test("SQLite 落地端口的流量要记到端口自己头上，不只记进租户配额", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-inbound-usage-"));
  const databasePath = path.join(directory, "inbound-usage.db");
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
      const exec = (sql, p = []) => runtime.executeRaw(sql, p);
      const query = (sql, p = []) => runtime.queryRaw(sql, p);

      await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'owner', 'hash', 'user')");
      await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (10, '落地机', '127.0.0.10', 'slave', 'tok10', 1)");
      await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (20, '别的机器', '127.0.0.20', 'slave', 'tok20', 1)");
      // 自建：入站 5（多用户，派生出两个节点，共用这一个端口）
      await exec("INSERT INTO proxy_inbounds (id, userId, hostId, name, protocol, port, isEnabled) VALUES (5, 1, 10, '自建端口', 'vless', 34567, 1)");
      await exec("INSERT INTO proxy_nodes (id, userId, name, protocol, address, port, uuid, isEnabled, inboundId, inboundUserId) VALUES (1, 1, '自建-甲', 'vless', '127.0.0.10', 34567, 'u1', 1, 5, 1)");
      await exec("INSERT INTO proxy_nodes (id, userId, name, protocol, address, port, uuid, isEnabled, inboundId, inboundUserId) VALUES (2, 1, '自建-乙', 'vless', '127.0.0.10', 34567, 'u2', 1, 5, 2)");
      // 停用的入站
      await exec("INSERT INTO proxy_inbounds (id, userId, hostId, name, protocol, port, isEnabled) VALUES (6, 1, 10, '停用的', 'vless', 34568, 0)");

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
      const report = async (token, reportId, stats) => {
        const response = await fetch(baseUrl + "/api/agent/traffic", {
          method: "POST",
          headers: { authorization: "Bearer " + token, "content-type": "application/json" },
          body: JSON.stringify({ reportId, reportProducerId: "p-" + token, stats }),
        });
        assert.equal(response.status, 200);
      };
      const portUsed = async (id) =>
        Number((await query('SELECT "trafficUsed" FROM "proxy_inbounds" WHERE "id" = ?', [id]))[0].trafficUsed || 0);

      await report("tok10", "u1", [{ ruleId: INBOUND_BASE + 5, bytesIn: 600, bytesOut: 400 }]);
      assert.equal(await portUsed(5), 1000, "端口自己也要记一笔，不能只记进租户配额");

      // 再来一次要累加，不是覆盖。
      await report("tok10", "u2", [{ ruleId: INBOUND_BASE + 5, bytesIn: 250, bytesOut: 250 }]);
      assert.equal(await portUsed(5), 1500, "第二次上报要加上去");

      // 计量归属的那几条守卫，端口这一侧同样得守住 —— 否则等于开了个后门，
      // 别人可以隔着机器把你的端口额度刷爆。
      await report("tok20", "spoof", [{ ruleId: INBOUND_BASE + 5, bytesIn: 500000, bytesOut: 0 }]);
      assert.equal(await portUsed(5), 1500, "别的机器报这个端口号，一个字节都不能算上去");

      await report("tok10", "disabled", [{ ruleId: INBOUND_BASE + 6, bytesIn: 7777, bytesOut: 0 }]);
      assert.equal(await portUsed(6), 0, "停用的端口不该还在记");

      await report("tok10", "negative", [{ ruleId: INBOUND_BASE + 5, bytesIn: -900, bytesOut: -100 }]);
      assert.equal(await portUsed(5), 1500, "负数上报不能把已用量倒扣回去");

      // 派生节点上不重复记：一个端口的字节数分不到几份凭据头上，
      // 记到每个节点上再求和就会翻倍。
      const nodeRows = await query('SELECT "id", "trafficUsed" FROM "proxy_nodes" WHERE "inboundId" = 5', []);
      for (const row of nodeRows) {
        assert.equal(
          Number(row.trafficUsed || 0),
          0,
          "派生节点上不该重复记 —— 多用户入站会翻倍，节点 #" + row.id,
        );
      }

      console.log("OK");
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
