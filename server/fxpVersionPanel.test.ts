import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FXP_MIN_WIRE_VERSION, FXP_RUNTIME_VERSION } from "../shared/versions";

/**
 * 用户那台：所有主机都报 Agent 2.2.20x，可 Po01 的 FXP 是升级时下载失败后留下的握手 v2
 * 旧版本。面板只看 Agent 版本：Po01 不在「可升级」里，点升级说「已是最新」，Po01→Jinx 的
 * NEX 隧道诊断能过、流量全超时。
 *
 * 起一个真的 sqlite、真的心跳路由和真的 hosts / tunnels / rules 接口，把 Po01 报成旧 FXP，
 * 看面板每一处是不是都认出来了。
 */

type Outcome = Record<string, any>;

function run(): Outcome {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-fxp-version-"));
  const databasePath = path.join(directory, "fxp.db");
  const logDirectory = path.join(directory, "logs");
  fs.mkdirSync(logDirectory, { recursive: true });
  const script = String.raw`
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import express from "express";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const { AGENT_VERSION, FXP_RUNTIME_VERSION } = await import(url("shared/versions.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);
    const now = Math.floor(Date.now() / 1000);

    await exec("INSERT INTO users (id, username, password, role, canAddRules, manualCanAddRules, accountEnabled) VALUES (1, 'admin', 'hash', 'admin', 1, 1, 1)");
    for (const [id, name, ip, token] of [[1, "Po0", "203.0.113.1", "tok1"], [2, "Po01", "203.0.113.2", "tok2"], [3, "Jinx", "203.0.113.3", "tok3"]]) {
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "agentVersion", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)',
        [id, name, ip, ip, "slave", token, AGENT_VERSION, now],
      );
    }
    await exec('INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled", "isRunning", secret) VALUES (1, ?, 1, 3, ?, ?, 1, 1, 1, ?)', ["华南-香港", "forwardx", 46795, "secret-a"]);
    await exec('INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled", "isRunning", secret) VALUES (2, ?, 2, 3, ?, ?, 1, 1, 1, ?)', ["华南-香港2", "forwardx", 46796, "secret-b"]);
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "tunnelId") VALUES (11, 2, ?, ?, ?, ?, ?, ?, 1, 1, 1, 2)',
      ["rule-11", "gost", "both", 40981, "zzy.example.invalid", 19001],
    );

    // 升级前要去 GitHub 确认资产：测试里答「都在」。
    const { AGENT_ASSET_NAMES } = await import(url("server/agentAssets.ts"));
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const target = String(input && input.url ? input.url : input);
      if (target.startsWith("https://")) {
        return new Response(JSON.stringify({ assets: [...AGENT_ASSET_NAMES].map((name) => ({ name, state: "uploaded", size: 1 })) }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return realFetch(input, init);
    };

    const heartbeat = await import(url("server/agentHeartbeatRoute.ts"));
    const { agentHeartbeatGate } = await import(url("server/agentHeartbeatGate.ts"));
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
    const hostIdByToken = { tok1: 1, tok2: 2, tok3: 3 };
    const beat = async (token, fxpVersion) => {
      agentHeartbeatGate.clear?.(hostIdByToken[token]);
      const response = await fetch(base + "/api/agent/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ agentVersion: AGENT_VERSION, fxpVersion, uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1 }),
      });
      const body = await response.json();
      if (response.status !== 200) throw new Error("心跳没通: " + response.status + " " + JSON.stringify(body));
      return body;
    };
    const fxpVersions = async () => Object.fromEntries((await query('SELECT id, "fxpVersion" FROM hosts ORDER BY id')).map((row) => [row.id, row.fxpVersion]));

    await beat("tok1", FXP_RUNTIME_VERSION);
    await beat("tok2", "legacy-v2");
    await beat("tok3", FXP_RUNTIME_VERSION);
    const stored = await fxpVersions();
    await beat("tok2", "2.2.1; rm -rf /");
    const afterGarbage = await fxpVersions();
    await beat("tok2", undefined);
    const afterMissingField = await fxpVersions();

    const context = { req: { headers: {} }, res: { clearCookie() {} }, user: { id: 1, username: "admin", role: "admin", accountEnabled: true }, authSession: null, authFailureReason: null };
    const { hostsRouter } = await import(url("server/routers/hosts.ts"));
    const hosts = hostsRouter.createCaller(context);
    const page = await hosts.listPage({ page: 1, pageSize: 20 });
    const candidates = await hosts.upgradeCandidates({});
    const upgradeCurrent = await hosts.requestAgentUpgrade({ hostId: 1, targetVersion: null });
    const upgradeStale = await hosts.requestAgentUpgrade({ hostId: 2, targetVersion: null });
    const upgradeRow = (await query('SELECT "agentUpgradeRequested", "agentUpgradeTargetVersion" FROM hosts WHERE id = 2'))[0];

    // 升级请求还挂着：Agent 版本没变，但 FXP 还是旧的 —— 心跳不能把它当成「升级完了」清掉。
    await exec('UPDATE hosts SET "agentUpgradeRequestedAt" = ? WHERE id = 2', [now - 60]);
    const staleBeat = await beat("tok2", "legacy-v2");
    const stillRequested = (await query('SELECT "agentUpgradeRequested" FROM hosts WHERE id = 2'))[0];
    // 重装完 FXP 之后报上来的是新版本：这次才算升级完成。
    const fixedBeat = await beat("tok2", FXP_RUNTIME_VERSION);
    const cleared = (await query('SELECT "agentUpgradeRequested" FROM hosts WHERE id = 2'))[0];
    await beat("tok2", "legacy-v2");

    const { tunnelsRouter } = await import(url("server/routers/tunnels.ts"));
    const tunnels = tunnelsRouter.createCaller(context);
    const tunnelList = await tunnels.list();
    const tunnelTest = await tunnels.test({ id: 2 });
    const healthyTunnelIssues = tunnelList.find((tunnel) => Number(tunnel.id) === 1)?.fxpIssues;
    const staleTunnelIssues = tunnelList.find((tunnel) => Number(tunnel.id) === 2)?.fxpIssues;
    const tunnelRow = (await query('SELECT "lastTestStatus", "lastTestMessage" FROM tunnels WHERE id = 2'))[0];

    const { rulesRouter } = await import(url("server/routers/rules.ts"));
    const selfTest = await rulesRouter.createCaller(context).startSelfTest({ ruleId: 11 });
    const selfTestRow = (await query('SELECT status, message, "hostId" FROM forward_tests WHERE id = ?', [selfTest.id]))[0];

    server.close();
    console.log("OUTCOME " + JSON.stringify({
      stored, afterGarbage, afterMissingField,
      page: { outdatedItems: page.outdatedItems, onlineOutdatedItems: page.onlineOutdatedItems, fxpVersions: page.items.map((item) => [item.id, item.fxpVersion]) },
      candidates, upgradeCurrent, upgradeStale, upgradeRow,
      staleBeatUpgrade: staleBeat.agentUpgrade || null, stillRequested, fixedBeatUpgrade: fixedBeat.agentUpgrade || null, cleared,
      healthyTunnelIssues, staleTunnelIssues, tunnelTest, tunnelRow,
      selfTestRow,
    }));
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FORWARDX_LOG_DIR: logDirectory },
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("OUTCOME "));
  assert.ok(line, `没拿到结果：\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice("OUTCOME ".length));
}

const outcome = run();
const staleMessage = `Po01 的 FXP 版本过旧（早于 ${FXP_MIN_WIRE_VERSION}），需要升级 Agent`;

test("心跳里的 fxpVersion 存进主机表；乱七八糟的值和没报都不覆盖", () => {
  assert.deepEqual(outcome.stored, { 1: FXP_RUNTIME_VERSION, 2: "legacy-v2", 3: FXP_RUNTIME_VERSION });
  assert.deepEqual(outcome.afterGarbage, outcome.stored);
  assert.deepEqual(outcome.afterMissingField, outcome.stored, "旧 Agent 不报 fxpVersion 时保留原值");
});

test("Agent 已是最新、FXP 却旧了：算进「可升级」，一键升级真的会下发", () => {
  assert.equal(outcome.page.outdatedItems, 1);
  assert.equal(outcome.page.onlineOutdatedItems, 1);
  assert.deepEqual(outcome.page.fxpVersions.sort(), [[1, FXP_RUNTIME_VERSION], [2, "legacy-v2"], [3, FXP_RUNTIME_VERSION]]);
  assert.deepEqual(outcome.candidates.ids, [2]);
  assert.equal(outcome.upgradeCurrent.alreadyLatest, true, "Agent 和 FXP 都是最新的主机仍然是「已是最新」");
  assert.notEqual(outcome.upgradeStale.alreadyLatest, true, "FXP 旧了的主机不能回「已是最新」");
  assert.equal(outcome.upgradeStale.success, true);
  assert.equal(Number(outcome.upgradeRow.agentUpgradeRequested), 1);
});

test("升级请求要等 FXP 也换好了才算完成", () => {
  assert.ok(outcome.staleBeatUpgrade, "FXP 还是旧的：心跳要把升级指令发下去");
  assert.equal(Number(outcome.stillRequested.agentUpgradeRequested), 1);
  assert.equal(outcome.fixedBeatUpgrade, null);
  assert.equal(Number(outcome.cleared.agentUpgradeRequested), 0);
});

test("NEX 隧道列表标出握不上的节点，正常的隧道不标", () => {
  assert.deepEqual(outcome.healthyTunnelIssues, []);
  assert.equal(outcome.staleTunnelIssues.length, 1);
  assert.equal(outcome.staleTunnelIssues[0].hostId, 2);
  assert.equal(outcome.staleTunnelIssues[0].fxpVersion, "legacy-v2");
  assert.equal(outcome.staleTunnelIssues[0].message, staleMessage);
});

test("隧道诊断直接判失败并说清原因，而不是 tcping 一下就说通", () => {
  assert.equal(outcome.tunnelTest.success, false);
  assert.ok(String(outcome.tunnelTest.message).includes(staleMessage), outcome.tunnelTest.message);
  assert.equal(outcome.tunnelRow.lastTestStatus, "failed");
  assert.ok(String(outcome.tunnelRow.lastTestMessage).includes(staleMessage));
});

test("走这条隧道的规则自检同样直接失败", () => {
  assert.equal(outcome.selfTestRow.status, "failed");
  assert.ok(String(outcome.selfTestRow.message).includes(staleMessage), outcome.selfTestRow.message);
});
