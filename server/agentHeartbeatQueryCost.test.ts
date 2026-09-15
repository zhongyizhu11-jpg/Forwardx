import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 一次 Agent 心跳打多少次库。
 *
 * 这是全站**最热的一条路**：每台机器每几秒打一次，一个商家几百台机器就是每秒
 * 几十上百次。别处多一条查询只是慢一点，这里多一条要乘以机器数再乘以频率。
 *
 * 量下来现状很干净：稳态两条（取这台机器 + 写回在线状态），冷启动 31 条（要算
 * 一遍下发给 Agent 的期望状态，之后靠签名缓存住）。而且**不随机器数和规则数增长**。
 *
 * 所以这一组不测「快不快」（那会变成看机器脸色的脆测试），只钉两件事：
 * 绝对条数不许涨，以及规模放大四倍时条数不许跟着涨。用绝对值而不是「跟上一次比」
 * —— 相对基准会跟着劣化一起漂，等于没订。
 */
test("一次心跳的打库次数不随机器数和规则数增长", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-hb-cost-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    // 钩子必须挂在建库之前：drizzle 的和裸 SQL 的语句都从 prepare 过。
    const Database = (await import("better-sqlite3")).default;
    const originalPrepare = Database.prototype.prepare;
    let recording = false;
    let statements = [];
    Database.prototype.prepare = function (sql) {
      if (recording) statements.push(String(sql));
      return originalPrepare.call(this, sql);
    };

    const url = (f) => pathToFileURL(path.join(process.cwd(), f)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (s, p = []) => runtime.executeRaw(s, p);

    const N = Number(process.env.HB_SCALE || 10);
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
    for (let h = 1; h <= N; h++) {
      await exec(
        "INSERT INTO hosts (id, name, ip, hostType, agentToken, userId, isOnline) VALUES (?, ?, ?, 'slave', ?, 1, 1)",
        [h, "h" + h, "10.0.0." + h, "tok" + h],
      );
    }
    for (let r = 1; r <= N * 3; r++) {
      await exec(
        "INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, isEnabled) VALUES (?, ?, ?, 'gost', 'tcp', ?, '127.0.0.1', 80, 1, 1)",
        [r, ((r - 1) % N) + 1, "r" + r, 20000 + r],
      );
    }

    const express = (await import("express")).default;
    const heartbeat = await import(url("server/agentHeartbeatRoute.ts"));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const authorization = String(req.headers.authorization || "");
      req.agentToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      next();
    });
    heartbeat.registerAgentHeartbeatRoute(app);
    const server = http.createServer(app);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const base = "http://127.0.0.1:" + server.address().port;

    const beat = async (token) => {
      const response = await fetch(base + "/api/agent/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ agentVersion: "2.2.195", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1 }),
      });
      return response.status;
    };

    statements = []; recording = true;
    const coldStatus = await beat("tok1");
    recording = false;
    const cold = statements.length;
    assert.equal(coldStatus, 200, "心跳要能通");

    await beat("tok1");
    statements = []; recording = true;
    assert.equal(await beat("tok1"), 200);
    recording = false;
    const warm = statements.length;

    console.log("HB_COST " + JSON.stringify({ scale: N, cold, warm }));

    /*
      稳态只该做两件事：按 token 取这台机器、写回在线状态和心跳时间。
      放宽到 6 是给将来一两条合理的新查询留的余地 —— 再多就说明有人
      把「按规则逐条查」塞进了每秒几十次的路上。
    */
    assert.ok(warm <= 6, "稳态心跳打库次数 " + warm + " 超了预算 6");
    // 冷启动要算一遍期望状态，31 条左右；留到 50 挡住数量级的劣化。
    assert.ok(cold <= 50, "冷启动心跳打库次数 " + cold + " 超了预算 50");

    server.close();
    await runtime.closeDatabase().catch(() => undefined);
  `;
  const run = (scale: number) => {
    const databasePath = path.join(directory, `hb-${scale}.db`);
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, NODE_ENV: "test", HB_SCALE: String(scale) },
      timeout: 120000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const line = result.stdout.split("\n").find((l) => l.includes("HB_COST"));
    assert.ok(line, `没拿到计数：${result.stdout}`);
    return JSON.parse(line.slice(line.indexOf("{"))) as { scale: number; cold: number; warm: number };
  };
  try {
    const small = run(10);
    const large = run(40);
    /*
      规模放大四倍，条数必须原地不动。这条才是真正拦 N+1 的 ——
      只订绝对值的话，一个「每台机器多查一次」的写法在小数据集上照样能过。
    */
    assert.equal(large.warm, small.warm, `稳态心跳随规模涨了：N=10 时 ${small.warm} 条，N=40 时 ${large.warm} 条`);
    assert.equal(large.cold, small.cold, `冷启动心跳随规模涨了：N=10 时 ${small.cold} 条，N=40 时 ${large.cold} 条`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
