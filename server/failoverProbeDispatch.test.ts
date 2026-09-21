import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 健康探测目标要真的走到 Agent 手里。
 *
 * 这一条盯的是整条链路：面板存的 `failoverProbeTarget` 和备用出站里的
 * `probeIp/probePort`，经过心跳下发之后，必须原样出现在 Agent 的主备规格里。
 *
 * 为什么值得单独测：这条路要穿过 rules.crud 的入参、库表、心跳里那段 actionFailover，
 * 中间任何一处漏掉字段，表现都是**面板上配好了、机器上没生效** —— 而主备是兜底
 * 功能，它悄悄不生效的时候没有任何人会发现，直到真出事那天。
 *
 * 探测目标本身解决的是：Agent 的健康检查就是对出站地址连一次 TCP。中转是
 * iptables/DNAT 时这一连是端到端的；中转是 gost、realm 这类用户态转发时，中转本地
 * 就把连接收下了 —— 连得上只能证明中转活着，证明不了它到落地那段还通。那种情况下
 * 中转的上游断了主备不会切，流量继续往死路里送。
 */

type DispatchedTarget = { targetIp: string; targetPort: number; probeIp?: string; probePort?: number };

function dispatchFailoverSpec(): { targets: DispatchedTarget[]; strategy: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-failover-probe-"));
  const databasePath = path.join(directory, "failover-probe.db");
  const script = String.raw`
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline") VALUES (1, ?, ?, ?, ?, ?, 1, 1)',
      ["入口机", "203.0.113.1", "203.0.113.1", "slave", "tok1"],
    );

    /*
      一条开着主备的 gost 规则：
        主出站  198.51.100.7:443   探测 198.51.100.7:9443
        备用    198.51.100.8:443   探测 198.51.100.8:9443
        备用    198.51.100.9:443   没填探测目标（应当退回探它自己）
    */
    const backups = [
      { targetIp: "198.51.100.8", targetPort: 443, probeIp: "198.51.100.8", probePort: 9443 },
      { targetIp: "198.51.100.9", targetPort: 443 },
    ];
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled",'
        + ' "failoverEnabled", "failoverStrategy", "failoverTargets", "failoverProbeTarget", "failoverSeconds", "recoverSeconds", "autoFailback")'
        + ' VALUES (1, 1, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, ?, 30, 90, 1)',
      ["主备规则", "gost", "tcp", 20001, "198.51.100.7", 443, "fallback", JSON.stringify(backups), "198.51.100.7:9443"],
    );

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

    const response = await fetch(base + "/api/agent/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok1" },
      body: JSON.stringify({ agentVersion: "2.3.362", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1 }),
    });
    const body = await response.json();
    server.close();
    if (response.status !== 200) throw new Error("心跳没通: " + response.status);

    const actions = (body.desiredState && body.desiredState.actions) || [];
    const withFailover = actions.find((action) => action && action.failover && action.failover.enabled);
    console.log("FAILOVERSPEC " + JSON.stringify(withFailover ? withFailover.failover : null));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    timeout: 180000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("FAILOVERSPEC "));
  assert.ok(line, `没拿到下发结果：\n${result.stdout}`);
  const spec = JSON.parse(line.slice("FAILOVERSPEC ".length));
  assert.ok(spec, "心跳里没有开着的主备规格 —— 这条测试的前提就没成立");
  return spec;
}

const spec = dispatchFailoverSpec();

test("主出站的探测目标下发到 Agent", () => {
  const main = spec.targets[0];
  assert.deepEqual(
    { targetIp: main.targetIp, targetPort: main.targetPort, probeIp: main.probeIp, probePort: main.probePort },
    { targetIp: "198.51.100.7", targetPort: 443, probeIp: "198.51.100.7", probePort: 9443 },
    "主出站的探测目标没走到 Agent —— 面板上配好了，机器上还在探出站地址本身",
  );
});

test("备用出站各自的探测目标下发到 Agent", () => {
  assert.deepEqual(
    spec.targets.slice(1).map((target: DispatchedTarget) => ({
      targetIp: target.targetIp, probeIp: target.probeIp ?? null, probePort: target.probePort ?? null,
    })),
    [
      { targetIp: "198.51.100.8", probeIp: "198.51.100.8", probePort: 9443 },
      // 没填探测目标的那条不该被塞上别人的 —— 它探的是自己，也就是老行为。
      { targetIp: "198.51.100.9", probeIp: null, probePort: null },
    ],
    "备用出站的探测目标没走到 Agent",
  );
});

test("出站清单本身没被探测目标搅乱", () => {
  // 主出站排第一、备用按顺序跟在后面，是 fallback 策略的语义依据。
  assert.deepEqual(
    spec.targets.map((target: DispatchedTarget) => `${target.targetIp}:${target.targetPort}`),
    ["198.51.100.7:443", "198.51.100.8:443", "198.51.100.9:443"],
  );
  assert.equal(spec.strategy, "fallback");
});
