import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 线路组走 ForwardX 隧道。
 *
 * FXP 的出口是整条隧道共用的一个进程，按入口握手里给的目标拨出去（UDP 按面板给出口的
 * udpTargets），调度器只能放在出口机上（server/agentHeartbeatRoute.ts 的 forwardXSchedulerFailover）：
 *
 *   · 入口给 FXP 的目标换成出口本机的调度器（127.0.0.1:端口），入口自己不跑调度器 —— 上一版把
 *     调度器开在入口、又把 127.0.0.1 当目标发给出口，出口拨的是它自己的本机，那里什么都没有；
 *   · 出口机收到一条「只跑调度器」的运行规则（schedulerOnly，Agent 2.2.199 起），出口 FXP 的
 *     UDP 目标表也指向它；
 *   · 出口 Agent 早于 2.2.199 时什么都不下发，入口和出口都拨路径 A（经过中转就拨中转）；
 *   · 开着负载均衡时每个出口各跑一个调度器，要每个出口都够版本；
 *   · 调度器在出口，「现在走哪条」和评分是出口机报上来的 —— 出口机有权报这条规则。
 *
 * 起一个真的 sqlite 和真的心跳路由跑一遍。
 */

type EntryTarget = { targetIp: string; targetPort: number; failover: boolean };
type Scheduler = { sourcePort: number; forwardType: string; failover: any };
type Beat = {
  entry: Record<string, EntryTarget>;
  exitUdpTargets: Record<string, Array<{ ruleId: number; targetIp: string; targetPort: number }>>;
  schedulers: Record<string, Scheduler>;
  runningFailover: Record<string, any>;
};
type Outcome = {
  mainDial: { ip: string; port: number } | null;
  exitNew: Beat;
  entryNew: Beat;
  exitOld: Beat;
  entryOld: Beat;
  reportable: Record<string, number[]>;
  allowed: boolean;
  schedulerHosts: Record<string, number[]>;
};

function run(): Outcome {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-route-fxp-"));
  const databasePath = path.join(directory, "routes.db");
  const logDirectory = path.join(directory, "logs");
  fs.mkdirSync(logDirectory, { recursive: true });
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
    const query = (sql, params = []) => runtime.queryRaw(sql, params);
    const now = Math.floor(Date.now() / 1000);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    for (const [id, name, ip, token, version] of [
      [1, "出口", "203.0.113.1", "tok1", "2.2.199"],
      [2, "入口", "203.0.113.2", "tok2", "2.2.199"],
      [3, "中转", "203.0.113.3", "tok3", "2.2.199"],
      [4, "旧出口节点", "203.0.113.4", "tok4", "2.2.150"],
    ]) {
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "agentVersion", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)',
        [id, name, ip, ip, "slave", token, version, now],
      );
    }
    // 隧道 1：ForwardX，入口 2、出口 1。
    await exec(
      'INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled") VALUES (1, ?, 2, 1, ?, ?, 1, 1)',
      ["ForwardX 隧道", "forwardx", 23001],
    );
    // 隧道 2：ForwardX，开着负载均衡，另一个出口是 Agent 很旧的 4 号机。
    await exec(
      'INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled", "loadBalanceEnabled", "loadBalanceStrategy") VALUES (2, ?, 2, 1, ?, ?, 1, 1, 1, ?)',
      ["ForwardX 负载均衡", "forwardx", 23002, "round_robin"],
    );
    await exec('INSERT INTO tunnel_exit_nodes ("tunnelId", seq, "hostId", "listenPort", "isEnabled") VALUES (2, 1, 4, 23102, 1)');
    // 隧道 3：ForwardX，打开了 PROXY Protocol 的「出口发送到目标」。
    await exec(
      'INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled", "proxyProtocolExitSend") VALUES (3, ?, 2, 1, ?, ?, 1, 1, 1)',
      ["ForwardX 带 PROXY 头", "forwardx", 23003],
    );

    const direct = (key, dest) => ({ key, name: key, hops: [], dest, weight: 50, probe: null, dial: null });
    const insertRule = (id, tunnelId, protocol, sourcePort, failoverEnabled, paths, mode = "failover", strategy = "fallback") => exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "tunnelId",'
        + ' "failoverEnabled", "failoverStrategy", "failoverTargets", "failoverSeconds", "recoverSeconds", "autoFailback", "routeMode", "routePaths", "routeSwitchMode", "telegramErrorNotifyEnabled")'
        + ' VALUES (?, 2, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, 10, 60, 1, ?, ?, ?, 0)',
      [id, "fxp-" + id, "gost", protocol, sourcePort, "198.51.100.7", 443, tunnelId, failoverEnabled ? 1 : 0, strategy, "[]", mode, JSON.stringify(paths), "smooth"],
    );
    // 1：TCP+UDP 线路组，主线路经过 3 号中转，备用直连另一个落地。
    await insertRule(1, 1, "both", 24001, true, [
      { key: "main", name: "主线路", hops: [3], dest: null, weight: 50, probe: null, dial: null },
      direct("backup", { ip: "198.51.100.9", port: 443 }),
    ]);
    // 2：同一条隧道上不开线路组的 UDP 规则，什么都不该变。
    await insertRule(2, 1, "udp", 24002, false, []);
    // 3：负载均衡隧道上的 TCP 线路组。
    await insertRule(3, 2, "tcp", 24003, true, [direct("main", null), direct("backup", { ip: "198.51.100.9", port: 443 })]);
    // 4：带 PROXY 头的隧道上按访客固定。
    await insertRule(4, 3, "tcp", 24004, true, [direct("a", null), direct("b", { ip: "198.51.100.9", port: 443 })], "weighted", "ip_hash");

    const routeGroups = await import(url("server/routeGroups.ts"));
    await routeGroups.syncRouteRelayRulesForRule(1, { reason: "test" });
    const ruleRow = (await query('SELECT "routePaths" FROM forward_rules WHERE id = 1'))[0];
    const mainDial = JSON.parse(ruleRow.routePaths).find((item) => item.key === "main").dial || null;

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
    const beat = async (token, agentVersion) => {
      const response = await fetch(base + "/api/agent/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ agentVersion, uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1, forceReconcile: true }),
      });
      const body = await response.json();
      if (response.status !== 200) throw new Error("心跳没通: " + response.status + " " + JSON.stringify(body));
      const actions = (body.desiredState && body.desiredState.actions) || [];
      const entry = {};
      const exitUdpTargets = {};
      for (const action of actions) {
        const fxp = action && action.fxp;
        if (!fxp || action.op !== "apply") continue;
        if (fxp.role === "entry") {
          entry[String(action.ruleId)] = { targetIp: String(fxp.targetIp), targetPort: Number(fxp.targetPort), failover: !!action.failover };
        }
        if (fxp.role === "exit") exitUdpTargets[String(action.tunnelId)] = fxp.udpTargets || [];
      }
      // runningRules 在心跳回复的顶层（Agent 的 heartbeatResponse），不在 desiredState 里。
      const schedulers = {};
      const runningFailover = {};
      for (const rule of body.runningRules || []) {
        if (rule.schedulerOnly) {
          schedulers[String(rule.ruleId)] = { sourcePort: Number(rule.sourcePort), forwardType: String(rule.forwardType), failover: rule.failover };
        } else if (rule.failover && rule.failover.enabled) {
          runningFailover[String(rule.ruleId)] = rule.failover;
        }
      }
      return { entry, exitUdpTargets, schedulers, runningFailover };
    };
    const setVersion = (hostId, version) => exec('UPDATE hosts SET "agentVersion" = ? WHERE id = ?', [version, hostId]);

    const exitNew = await beat("tok1", "2.2.199");
    await setVersion(1, "2.2.199");
    const entryNew = await beat("tok2", "2.2.199");
    const exitOld = await beat("tok1", "2.2.198");
    await setVersion(1, "2.2.198");
    const entryOld = await beat("tok2", "2.2.199");
    server.close();

    // 谁有权报这条规则的「现在走哪条」和评分。
    const db = await import(url("server/db.ts"));
    const reportable = {};
    for (const hostId of [1, 2, 3, 4]) {
      reportable[hostId] = (await db.getForwardRuleFailoverLinesForAgent(hostId))
        .map((row) => Number(row.id))
        .filter((id) => id <= 4)
        .sort((a, b) => a - b);
    }

    const crud = await import(url("server/routers/rules.crud.ts"));
    let allowed = true;
    try {
      crud.requireMainBackupAllowed({ enabled: true, protocol: "both", forwardType: "gost", tunnelId: 1, tunnelMode: "forwardx", isAdmin: false });
    } catch {
      allowed = false;
    }
    const schedulerHosts = {};
    for (const tunnelId of [1, 2]) {
      schedulerHosts[tunnelId] = crud.routeSchedulerHostIds(2, await db.getTunnelById(tunnelId), await db.getTunnelExitNodes(tunnelId));
    }
    console.log("OUTCOME " + JSON.stringify({ mainDial, exitNew, entryNew, exitOld, entryOld, reportable, allowed, schedulerHosts }));
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

test("前提：主线路经过中转，解析出了拨号地址", () => {
  assert.ok(outcome.mainDial, "主线路经过中转，应当解析出拨号地址");
  assert.equal(outcome.mainDial!.ip, "203.0.113.3");
});

test("出口 Agent 2.2.199：出口机只跑调度器，不占规则端口", () => {
  const scheduler = outcome.exitNew.schedulers["1"];
  assert.ok(scheduler, "出口机没收到调度器");
  assert.equal(scheduler.forwardType, "route-scheduler");
  assert.equal(scheduler.failover.enabled, true);
  assert.equal(scheduler.sourcePort, scheduler.failover.listenPort, "只跑调度器的运行规则按调度器自己的端口认");
  assert.equal(scheduler.failover.bindAddress, "127.0.0.1");
  assert.equal(scheduler.failover.protocol, "both");
  assert.deepEqual(
    scheduler.failover.targets.map((target: any) => `${target.targetIp}:${target.targetPort}`),
    [`${outcome.mainDial!.ip}:${outcome.mainDial!.port}`, "198.51.100.9:443"],
  );
  assert.equal(scheduler.failover.proxyProtocolReceive, false, "隧道没开「出口发送到目标」时出口不发 PROXY 头");
});

test("入口把 FXP 的目标换成出口本机的调度器，自己不跑调度器", () => {
  const port = outcome.exitNew.schedulers["1"].failover.listenPort;
  assert.deepEqual(outcome.entryNew.entry["1"], { targetIp: "127.0.0.1", targetPort: port, failover: false });
  assert.equal(outcome.entryNew.runningFailover["1"], undefined, "入口不该再起调度器");
  assert.deepEqual(outcome.entryNew.schedulers, {}, "入口不跑只调度的规则");
});

test("出口 FXP 的 UDP 目标表：线路组规则交给调度器，别的规则照旧", () => {
  const port = outcome.exitNew.schedulers["1"].failover.listenPort;
  const targets = outcome.exitNew.exitUdpTargets["1"];
  assert.ok(targets, "出口没收到 FXP 规格");
  assert.deepEqual(targets.find((item) => item.ruleId === 1), { ruleId: 1, targetIp: "127.0.0.1", targetPort: port });
  assert.deepEqual(targets.find((item) => item.ruleId === 2), { ruleId: 2, targetIp: "198.51.100.7", targetPort: 443 });
});

test("不开线路组的规则：入口照旧把规则目标给出口，出口没有调度器", () => {
  assert.deepEqual(outcome.entryNew.entry["2"], { targetIp: "198.51.100.7", targetPort: 443, failover: false });
  assert.equal(outcome.exitNew.schedulers["2"], undefined);
});

test("出口 Agent 早于 2.2.199：不下发调度，入口和出口都拨路径 A（经过中转就拨中转）", () => {
  const dial = outcome.mainDial!;
  assert.deepEqual(outcome.exitOld.schedulers, {}, "老 Agent 认不出只跑调度器的规则，会去装端口状态");
  assert.deepEqual(outcome.entryOld.entry["1"], { targetIp: dial.ip, targetPort: dial.port, failover: false });
  const targets = outcome.exitOld.exitUdpTargets["1"];
  assert.ok(targets, "出口没收到 FXP 规格");
  assert.deepEqual(targets.find((item) => item.ruleId === 1), { ruleId: 1, targetIp: dial.ip, targetPort: dial.port });
});

test("负载均衡隧道：有一个出口的 Agent 太旧，就都不调度、都拨路径 A", () => {
  assert.equal(outcome.exitNew.schedulers["3"], undefined, "另一个出口还是老 Agent，入口给的目标对每个出口都一样");
  assert.deepEqual(outcome.entryNew.entry["3"], { targetIp: "198.51.100.7", targetPort: 443, failover: false });
  assert.deepEqual(outcome.schedulerHosts["2"], [1, 4], "线路面板按两个出口里最旧的那台说");
  assert.deepEqual(outcome.schedulerHosts["1"], [1]);
});

test("按访客固定：隧道打开「出口发送到目标」时，调度器从出口发的 PROXY 头里读访客，头原样转给落地", () => {
  const scheduler = outcome.exitNew.schedulers["4"];
  assert.ok(scheduler, "出口机没收到调度器");
  assert.equal(scheduler.failover.strategy, "ip_hash");
  assert.equal(scheduler.failover.proxyProtocolReceive, true);
  assert.equal(scheduler.failover.proxyProtocolSend, true);
  assert.equal(scheduler.failover.proxyProtocolStrip, undefined, "头是给落地的，不能扔");
  assert.deepEqual(outcome.entryNew.entry["4"], { targetIp: "127.0.0.1", targetPort: scheduler.failover.listenPort, failover: false });
});

test("出口机有权报隧道上的线路组，中转机没有", () => {
  assert.deepEqual(outcome.reportable["1"], [1, 2, 3, 4], "主出口");
  assert.deepEqual(outcome.reportable["4"], [3], "负载均衡的出口节点");
  assert.deepEqual(outcome.reportable["2"], [1, 2, 3, 4], "入口（规则所在的机器）照旧");
  assert.deepEqual(outcome.reportable["3"], [], "中转机只报它自己的中继规则");
});

test("保存时放开 ForwardX 隧道", () => {
  assert.equal(outcome.allowed, true);
});
