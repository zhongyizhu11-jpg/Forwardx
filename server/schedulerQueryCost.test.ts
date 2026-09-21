import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 月度流量重置的打库预算。
 *
 * 这个任务无人值守、每小时跑一次，而且随面板规模增长。退化了界面上完全看不出来 ——
 * 只会表现为「面板越用越卡」，而且没人知道是谁在卡。
 *
 * 成本分两种，必须分开看：
 *
 *   · **首轮**：重置日那一次，该重置的全在这一轮做掉。按用户/主机数线性是必然的
 *     —— 每个人的流量都得真的清一次。
 *   · **稳态**：其余时间每小时一次。一个月七百多次都长这样，它才是长期成本。
 *     这一轮**本该什么都不做**。
 *
 * 原来稳态是精确的 3N + 5 次查询、N 次写（N=4 → 17/4，N=16 → 53/16，N=64 → 197/64）：
 * 每个有生效订阅的用户都要进一趟锁，进去先重新对齐（一次查、一次几乎必然命中 0 行
 * 的 UPDATE），再查一次「有没有到期该充的」，然后什么都没做就出来。一千个用户就是
 * 每小时三千次白跑的往返。
 *
 * 现在「有没有活可做」在外面那一次全量读里就判完了（见 billingRepository 的
 * subscriptionCycleNeedsWork），稳态是常数 6 次查询、0 次写，与规模无关。
 *
 * 这一组盯三件事：
 *
 *   · 首轮真按规模做了事 —— 否则下面量的「稳态」只是两次空跑，毫无意义。
 *   · 收敛之后一个字节都不写。
 *   · 收敛之后的打库次数在两个规模下**完全相等**。写成「不超过多少倍」的话，
 *     「每个用户多打一次库」这种退化会被余量整个吸收，棘轮就不响了。
 */

type Round = { queries: number; writes: number };
type Probe = {
  first: Round;
  repair: Round;
  settled: Round;
  brokenAddonCycleResetAt: number | null;
  subscriptionResetAt: number | null;
  /** 被改成「已到点」的那份订阅，修完之后有没有真的充过一轮。 */
  dueSubscriptionLastResetAt: number | null;
  /** 被改歪了下次重置时刻的那份订阅，以及一份没动过的参照。 */
  driftedSubscriptionResetAt: number | null;
  intactSubscriptionResetAt: number | null;
  /** 「已经到点、但存的值恰好就是算出来的那个」——只有第一条判据能救它。 */
  silentlyDueLastResetAt: number | null;
};

function runProbe(scale: number): Probe {
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
    const GB = 1024 ** 3;
    // 订阅得留足一年：重置边界要是落在到期之后，这份订阅根本不需要对齐 ——
    // 那样种子看着热闹，其实整条对齐路径一次都没走到。
    const farFuture = now + 365 * 24 * 3600;

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
    await exec(
      'INSERT INTO subscription_plans (id, name, "priceCents", "durationDays", "portCount", "trafficLimit", "isActive", "createdAt", "updatedAt") VALUES (1, ?, 1000, 30, 5, ?, 1, ?, ?)',
      ["月付", 500 * GB, now, now],
    );
    for (let u = 2; u <= N + 1; u++) {
      await exec(
        'INSERT INTO users (id, username, password, role, email, "expiresAt", "trafficAutoReset", "trafficResetDay", "trafficLimit", "trafficUsed") VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)',
        [u, "u" + u, "h", "user", "u" + u + "@example.com", farFuture, 10 * GB, 9 * GB],
      );
      await exec(
        'INSERT INTO user_subscriptions (id, "userId", "planId", status, "startedAt", "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, 1, ?, ?, ?, ?, ?)',
        // 6 号订阅开得早一些：它的本月重置日已经过去了，而开通日比那还早，
        // 于是「算出来的下次重置时刻」正好落在过去 —— 下面要用这一点。
        [u, u, "active", now - (u === 6 ? 60 : 10) * 24 * 3600, farFuture, now, now],
      );
      // 一半的人带一个生效流量包：加油包的周期末尾也要跟着订阅走，
      // 不铺的话那条 UPDATE 永远命中 0 行，等于没测。
      if (u % 2 === 0) {
        await exec(
          'INSERT INTO user_traffic_addons (id, "userId", "subscriptionId", "planId", "trafficBytes", status, "createdAt", "updatedAt") VALUES (?, ?, ?, 1, ?, ?, ?, ?)',
          [u, u, u, 50 * GB, "active", now, now],
        );
      }
    }
    for (let h = 1; h <= N; h++) {
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat", "trafficAutoReset", "trafficResetDay", "trafficLimit") VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1, 1, ?)',
        [h, "机" + h, "10.2.0." + h, "10.2.0." + h, "slave", "tk" + h, 2 + (h % N), now, 5 * GB],
      );
    }

    const sched = await import(url("server/scheduler.ts"));
    const round = async () => {
      statements = [];
      recording = true;
      await sched.runMonthlyTrafficReset();
      recording = false;
      return {
        queries: statements.length,
        writes: statements.filter((sql) => /^\s*(insert|update|delete)/i.test(sql)).length,
      };
    };

    const first = await round();

    /*
      把一个加油包的周期末尾改歪，再跑一轮。

      这一条单独拿出来试，是因为它是预筛里**唯一**不能从订阅那一行看出来的判据：
      订阅本身已经对齐了、也没到期，光看订阅会得出「这个人没事」。要是预筛漏了
      加油包这一条，这个流量包的有效期就会一直错下去 —— 而错的方向是用户凭空
      多出或少掉一段流量，账对不上，且没有任何地方会报错。
    */
    const brokenAddonId = 2;
    await exec('UPDATE user_traffic_addons SET "cycleResetAt" = ?, "expiresAt" = ? WHERE id = ?',
      [now + 12345, now + 12345, brokenAddonId]);
    // 另外两条判据也各找一份订阅试：3 号已经到点该充，5 号存着的下次重置时刻是错的。
    // 4 号不动，做参照。
    await exec('UPDATE user_subscriptions SET "nextTrafficResetAt" = ? WHERE id = 3', [now - 600]);
    await exec('UPDATE user_subscriptions SET "nextTrafficResetAt" = ? WHERE id = 5', [now + 12345]);
    /*
      6 号最阴：把它的下次重置时刻设成本月的重置日（已经过去了），而这个值**正好
      就是**对齐算出来的那一个 —— 于是「算出来的和存的不一样」这条判据看不出问题，
      只有「已经到了该清流量的时刻」这条能把它捞进来。不设这一条的话，那条判据
      看上去可以删掉而测试照样全绿。
    */
    const { billingMonthlyBoundary } = await import(url("shared/billingTime.ts"));
    await exec('UPDATE user_subscriptions SET "nextTrafficResetAt" = ?, "lastTrafficResetAt" = NULL WHERE id = 6',
      [Math.floor(billingMonthlyBoundary(new Date(now * 1000), 1).getTime() / 1000)]);
    const repair = await round();

    // 第三轮：该重置、该对齐、该修的都做完了，这一轮才是长期稳态。
    const settled = await round();

    const readOnly = new Database(process.env.FORWARDX_TEST_DB, { readonly: true });
    const addonRow = originalPrepare
      .call(readOnly, 'SELECT "cycleResetAt", "subscriptionId" FROM user_traffic_addons WHERE id = ?')
      .get(brokenAddonId);
    const subscriptionOf = (id) => originalPrepare
      .call(readOnly, 'SELECT "nextTrafficResetAt", "lastTrafficResetAt" FROM user_subscriptions WHERE id = ?')
      .get(id);
    const subscriptionRow = subscriptionOf(Number(addonRow?.subscriptionId || 0));

    console.log("SCHEDCOST " + JSON.stringify({
      first,
      repair,
      settled,
      brokenAddonCycleResetAt: addonRow?.cycleResetAt ?? null,
      subscriptionResetAt: subscriptionRow?.nextTrafficResetAt ?? null,
      dueSubscriptionLastResetAt: subscriptionOf(3)?.lastTrafficResetAt ?? null,
      driftedSubscriptionResetAt: subscriptionOf(5)?.nextTrafficResetAt ?? null,
      intactSubscriptionResetAt: subscriptionOf(4)?.nextTrafficResetAt ?? null,
      silentlyDueLastResetAt: subscriptionOf(6)?.lastTrafficResetAt ?? null,
    }));
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
  return JSON.parse(line.slice("SCHEDCOST ".length)) as Probe;
}

const small = runProbe(6);
const large = runProbe(16);

test("首轮确实按规模做了事", () => {
  // 首轮什么都没做的话，下面量的「稳态」就毫无意义 —— 那只是几次空跑。
  assert.ok(
    small.first.writes > 0 && large.first.writes > small.first.writes,
    `首轮应当按规模写得更多，拿到 ${small.first.writes} → ${large.first.writes}`,
  );
});

test("加油包的周期被改歪了，下一轮必须修回来", () => {
  /*
    预筛判「这个用户没活」判错的后果就在这里：订阅本身好好的，光看订阅什么都发现
    不了，只有把生效加油包也一起比对才看得出来。漏了这一条，流量包的有效期会一直
    错下去 —— 而且不会有任何地方报错。
  */
  for (const [scale, probe] of [[6, small], [16, large]] as const) {
    assert.ok(
      probe.repair.writes > 0,
      `${scale} 个用户时，加油包被改歪之后那一轮一个字都没写 —— 预筛把该做的活漏掉了`,
    );
    assert.equal(
      probe.brokenAddonCycleResetAt,
      probe.subscriptionResetAt,
      `${scale} 个用户时，加油包的周期末尾没被修回订阅的重置时刻`
        + `（加油包 ${probe.brokenAddonCycleResetAt}，订阅 ${probe.subscriptionResetAt}）`,
    );
  }
});

test("到点该充的、算错了下次重置时刻的，预筛都不许放过", () => {
  /*
    预筛的三条判据里，这是另外两条。判漏的后果各不相同但都很硬：
    该充的没充，用户的流量到了日子不回来；下次重置时刻错着不改，那一天永远不来。
  */
  for (const [scale, probe] of [[6, small], [16, large]] as const) {
    assert.ok(
      probe.dueSubscriptionLastResetAt !== null,
      `${scale} 个用户时，已经到点的那份订阅没被充 —— 用户的流量到了日子不会回来`,
    );
    assert.ok(
      probe.silentlyDueLastResetAt !== null,
      `${scale} 个用户时，那份「存的值正好等于算出来的值」的到期订阅没被充 —— `
        + "这一份只有「已经到点」那条判据看得见，漏了它就会一直到不了期",
    );
    assert.equal(
      probe.driftedSubscriptionResetAt,
      probe.intactSubscriptionResetAt,
      `${scale} 个用户时，被改歪的下次重置时刻没被纠回来`
        + `（改歪的 ${probe.driftedSubscriptionResetAt}，没动过的 ${probe.intactSubscriptionResetAt}）`,
    );
  }
});

test("收敛之后一个字节都不写", () => {
  for (const [scale, probe] of [[6, small], [16, large]] as const) {
    assert.equal(
      probe.settled.writes,
      0,
      `${scale} 个用户时，稳态仍然写了 ${probe.settled.writes} 次。该重置的上一轮已经重置完了，`
        + "这一轮本该什么都不做 —— 还在写就说明有东西每小时都被无谓地改一遍。",
    );
  }
});

test("稳态打库次数是个常数，不跟着面板规模涨", () => {
  assert.equal(
    large.settled.queries,
    small.settled.queries,
    `6 个用户时稳态打了 ${small.settled.queries} 次库，16 个用户时打了 ${large.settled.queries} 次 —— `
      + "又出现了按用户数放大的查询。这个任务每小时跑一次，一千个用户就是每小时几千次白跑的往返。",
  );
});
