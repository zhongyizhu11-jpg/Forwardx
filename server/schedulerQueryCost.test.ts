import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 定时任务的打库预算。
 *
 * 这些任务无人值守、每几分钟到几小时跑一次，而且全都随面板规模增长。退化了
 * 界面上完全看不出来 —— 只会表现为「面板越用越卡」，而且没人知道是谁在卡。
 * 同一轮测量里，转发组详情那个 N+1 就是这么揪出来的（每 5 分钟按组数放大）。
 *
 * 月度流量重置分两种成本，必须分开看：
 *
 *   · **首轮**：重置日那一次，该重置的全在这一轮做掉。按用户/主机数线性是
 *     必然的 —— 每个人的流量都得真的清一次。
 *   · **稳态**：其余时间每小时一次。一个月七百多次都长这样，它才是长期成本。
 *     这一轮**本该什么都不做**。
 *
 * 写这条时实测（用户数 = 主机数）：
 *
 *     规模    首轮              稳态
 *       4    109 次  24 写      17 次   4 写
 *      16    421 次  96 写      53 次  16 写
 *      64   1669 次 384 写     197 次  64 写
 *
 * 稳态下每个用户仍然是 3 次查询 + 1 次写。那次写来自
 * alignSubscriptionTrafficCycles 里无条件调用的 updateActiveTrafficAddonCycleEnd——
 * 用例里的用户连流量加油包都没有，这些 UPDATE 命中 0 行，纯粹是白跑的往返。
 * 一千个用户就是每小时三千次查询。
 *
 * 这条不修那个问题（计费这块不该凭一轮测量就动），只**把账钉住**：稳态的
 * 每用户成本只许降不许涨。
 *
 * ---
 *
 * 另外七个任务后来也逐个铺了数据量出来（过期订阅、过期用户、卡住的自检、配好的
 * 邮件与 Telegram、到量的主机/节点/端口、过了停机日的机器）。稳态成本如下，
 * 用户数 = 主机数 = 落地节点数 = 落地端口数 = N：
 *
 *     任务                            周期     N=4    N=16
 *     runSubscriptionExpirationCheck   1 小时     3       3
 *     runExpirationCheck               1 小时     1       1
 *     runSelfTestTimeoutSweep          按需       1       1
 *     runTcpingCleanup                 1 小时    11      11
 *     runHostDdnsReconcile             5 分钟     1       1
 *     runHostBillingCycleExtension     5 分钟     1       1
 *     runEmailReminders                6 小时    31     103   ← 按规模涨
 *     runTelegramReminders             6 小时    30     102   ← 按规模涨
 *
 * 前六个都是常数，符合预期：它们的首轮成本确实按规模走（每份到期订阅约 22 次、
 * 每个到期用户 3 次、每条超时自检 2 次写、每台到期机器 1 次写），但那是**一次性**
 * 的 —— 做完之后那一行就不再满足筛选条件了。
 *
 * 只有两路提醒是每轮都重新付一遍。它们已经修掉，由 server/reminderSweepCost.test.ts
 * 把「常数」这件事钉住 —— 那条测试同时盯着六条提醒路一条都不能少。
 */

/*
  预算按实测的模型订，不留大余量 —— 留松了就不是棘轮了。

  实测下来稳态是精确的 3N + 5（N=4 → 17，N=16 → 53，N=64 → 197），写是 N。
  第一版把查询预算写成 4N+8，结果「每用户多打一次库」这个反向验证**没红** ——
  富余把它整个吸收了。预算只留够抵抗噪声的那点量。
*/
const PER_USER_STEADY_QUERY_BUDGET = 3;
const STEADY_QUERY_FIXED_BUDGET = 8;      // 实测固定开销 5
const PER_USER_STEADY_WRITE_BUDGET = 1;
const STEADY_WRITE_FIXED_BUDGET = 4;

type Probe = Record<string, { first: { queries: number; writes: number }; steady: { queries: number; writes: number } }>;

function runProbe(scale: number) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sched-cost-"));
  const databasePath = path.join(directory, "sched.db");
  const script = String.raw`
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const Database = (await import("better-sqlite3")).default;
    const originalPrepare = Database.prototype.prepare;
    let recording = false;
    let statements = [];
    Database.prototype.prepare = function (sql) {
      if (recording) statements.push(String(sql));
      return originalPrepare.call(this, sql);
    };

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);

    const N = Number(process.env.SCALE);
    const now = Math.floor(Date.now() / 1000);
    const soon = now + 2 * 24 * 3600;

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
    for (let u = 2; u <= N + 1; u++) {
      await exec(
        'INSERT INTO users (id, username, password, role, email, "expiresAt", "trafficAutoReset", "trafficResetDay", "trafficLimit", "trafficUsed") VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)',
        [u, "u" + u, "h", "user", "u" + u + "@example.com", soon, 10 * 1024 ** 3, 9 * 1024 ** 3],
      );
      await exec(
        'INSERT INTO user_subscriptions (id, "userId", "planId", status, "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, 1, ?, ?, ?, ?)',
        [u, u, "active", soon, now, now],
      );
    }
    for (let h = 1; h <= N; h++) {
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat", "trafficAutoReset", "trafficResetDay", "trafficLimit") VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1, 1, ?)',
        [h, "机" + h, "10.2.0." + h, "10.2.0." + h, "slave", "tk" + h, 2 + (h % N), now, 5 * 1024 ** 3],
      );
    }

    const sched = await import(url("server/scheduler.ts"));
    const snapshot = () => ({
      queries: statements.length,
      writes: statements.filter((sql) => /^\s*(insert|update|delete)/i.test(sql)).length,
    });

    statements = []; recording = true;
    await sched.runMonthlyTrafficReset();
    recording = false;
    const first = snapshot();

    statements = []; recording = true;
    await sched.runMonthlyTrafficReset();
    recording = false;
    const steady = snapshot();

    console.log("SCHEDCOST " + JSON.stringify({ first, steady }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, SCALE: String(scale) },
    timeout: 180000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("SCHEDCOST "));
  assert.ok(line, `没拿到探测结果：\n${result.stdout}`);
  return JSON.parse(line.slice("SCHEDCOST ".length)) as Probe[string];
}

const scales = [4, 16] as const;
const probe: Probe = {};
for (const scale of scales) probe[String(scale)] = runProbe(scale);

test("月度重置的首轮确实按规模做了事", () => {
  // 首轮什么都没做的话，下面量的「稳态」就毫无意义 —— 那只是两次空跑。
  const small = probe["4"].first;
  const large = probe["16"].first;
  assert.ok(small.writes > 0 && large.writes > small.writes,
    `首轮应当按规模写得更多，拿到 ${small.writes} → ${large.writes}`);
});

test("月度重置的稳态成本，每个用户不许超预算", () => {
  /*
    稳态这一轮本该什么都不做：上一轮已经把该重置的都重置了。
    它现在仍然按用户数线性打库，这条钉住那个系数只许降不许涨。
  */
  for (const scale of scales) {
    const steady = probe[String(scale)].steady;
    assert.ok(
      steady.queries <= scale * PER_USER_STEADY_QUERY_BUDGET + STEADY_QUERY_FIXED_BUDGET,
      `${scale} 个用户时，稳态打了 ${steady.queries} 次库，`
        + `超了预算（每用户 ${PER_USER_STEADY_QUERY_BUDGET} 次 + ${STEADY_QUERY_FIXED_BUDGET} 次固定开销）。`
        + "这个任务每小时跑一次，多一次就是每天多二十四次。",
    );
    assert.ok(
      steady.writes <= scale * PER_USER_STEADY_WRITE_BUDGET + STEADY_WRITE_FIXED_BUDGET,
      `${scale} 个用户时，稳态写了 ${steady.writes} 次，超了预算`,
    );
  }
});

test("稳态成本不许比首轮还离谱地涨", () => {
  // 斜率式的看法：规模翻两番，稳态成本不该翻得更凶。
  const small = probe["4"].steady.queries;
  const large = probe["16"].steady.queries;
  assert.ok(
    large <= small * 4,
    `规模从 4 涨到 16（4 倍），稳态打库从 ${small} 涨到 ${large}（${(large / small).toFixed(1)} 倍）`
      + " —— 涨得比规模还快，说明里面有按规模平方的东西",
  );
});
