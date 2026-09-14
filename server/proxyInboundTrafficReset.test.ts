import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 「每月自动清零」这个开关得真的会清零。
 *
 * 我自己上个版本刚踩过：开关加了、设置存得下、界面上一切正常 —— 但没有任何东西
 * 去读它，日子到了数字纹丝不动。设置存了却不生效比没有这个开关更糟：人会以为
 * 已经安排好了，然后在某个月底被机房停机。
 *
 * 顺带守住重置日放开到 31 之后的那条：二月最后一天，设成每月 31 号的必须算到期。
 */
test("SQLite 落地端口按月自动清零，31 号在短月份落到月末", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-inbound-reset-"));
  const databasePath = path.join(directory, "inbound-reset.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const inbounds = await import(url("server/repositories/proxyInboundRepository.ts"));
    const { billingMonthlyBoundary } = await import(url("shared/billingTime.ts"));
    const { normalizeProxyNodeResetDay } = await import(url("shared/proxyNodeQuota.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, p = []) => runtime.executeRaw(sql, p);
    const query = (sql, p = []) => runtime.queryRaw(sql, p);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'owner', 'hash', 'user')");
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (1, '落地机', '10.0.0.1', 'slave', 'tok', 1)");
    const mk = (id, name, port, resetDay, auto) => exec(
      "INSERT INTO proxy_inbounds (id,userId,hostId,name,protocol,port,isEnabled,trafficLimit,trafficUsed,trafficAutoReset,trafficResetDay) VALUES (?,1,1,?,'shadowsocks',?,1,?,?,?,?)",
      [id, name, port, 100000000000, 92000000000, auto ? 1 : 0, resetDay],
    );
    await mk(1, "每月31号", 34567, 31, true);
    await mk(2, "每月15号", 34568, 15, true);
    await mk(3, "没开自动", 34569, 31, false);

    // 调度器里那段判断，原样搬过来。
    const dueForReset = (row, now) => {
      const boundary = billingMonthlyBoundary(now, normalizeProxyNodeResetDay(row?.trafficResetDay));
      if (now.getTime() < boundary.getTime()) return false;
      const last = row?.lastTrafficReset ? new Date(row.lastTrafficReset) : null;
      return !last || last.getTime() < boundary.getTime();
    };

    // 开了自动重置的才会被取出来 —— 没开的那个一开始就不该进这个列表。
    const candidates = await inbounds.getProxyInboundsForTrafficAutoReset();
    const ids = candidates.map((row) => Number(row.id)).sort();
    assert.deepEqual(ids, [1, 2], "只取开了自动清零的，实际 " + JSON.stringify(ids));

    // 2027-02-28 12:00 上海 = 二月最后一天，平年
    const lastDayOfFeb = new Date("2027-02-28T04:00:00Z");
    const due = candidates.filter((row) => dueForReset(row, lastDayOfFeb)).map((row) => Number(row.id)).sort();
    assert.deepEqual(
      due,
      [1, 2],
      "二月最后一天，每月 31 号的必须算到期（这正是原来会整月不重置的那一个）；15 号的早就过了",
    );

    // 真清零一次
    for (const row of candidates) {
      if (dueForReset(row, lastDayOfFeb)) await inbounds.resetProxyInboundTraffic(Number(row.id));
    }
    const used = async (id) =>
      Number((await query('SELECT "trafficUsed" FROM "proxy_inbounds" WHERE "id" = ?', [id]))[0].trafficUsed || 0);
    assert.equal(await used(1), 0, "到期的要真的清零，不只是算出「该清零」");
    assert.equal(await used(2), 0);
    assert.equal(await used(3), 92000000000, "没开自动清零的一个字节都不能动");

    // 重复触发要被挡住：调度每小时跑一次，不挡的话当天清二十几次。
    const after = await inbounds.getProxyInboundsForTrafficAutoReset();
    await exec("UPDATE proxy_inbounds SET trafficUsed = ? WHERE id = 1", [5000000000]);
    const stillDue = after
      .filter((row) => dueForReset({ ...row, lastTrafficReset: new Date(lastDayOfFeb.getTime() - 1000) }, lastDayOfFeb))
      .map((row) => Number(row.id));
    assert.ok(!stillDue.includes(1), "本周期已经清过就不该再清 —— 否则当天累计的量会被反复抹掉");
    assert.equal(await used(1), 5000000000, "被挡住时用量保持原样");

    // 月中不许提前清零
    const midMarch = new Date("2027-03-10T04:00:00Z");
    const dueMid = after.filter((row) => dueForReset({ ...row, lastTrafficReset: null }, midMarch)).map((row) => Number(row.id));
    assert.ok(!dueMid.includes(1), "3 月 10 号离月末还早，每月 31 号的不能提前清");

    /*
      最后真的把调度那一段跑一遍。

      上面几条测的是「算不算到期」，而我上个版本的 bug 不在算法里 —— 算法没写，
      调度器压根没去读这张表。只有真的调一次 runMonthlyTrafficReset，
      「开关接没接上」这件事才有人守着。
    */
    await exec("UPDATE proxy_inbounds SET trafficUsed = ?, lastTrafficReset = NULL WHERE id IN (1,2,3)", [77000000000]);
    /*
      重置日设成 1 号：那是当月第一天，今天不管是几号都已经过了，所以这条断言
      每天跑都成立。第一版我拿「每月 15 号」去测，结果 15 号之前整条断言被 if
      跳过 —— 一个大半个月都不生效的守卫，等于没有。
    */
    await exec("UPDATE proxy_inbounds SET trafficResetDay = 1 WHERE id = 2");
    const scheduler = await import(url("server/scheduler.ts"));
    await scheduler.runMonthlyTrafficReset();

    assert.equal(
      await used(2),
      0,
      "调度器没有去清落地端口 —— 界面上那个「每月自动清零」开关是死的",
    );
    assert.equal(await used(3), 77000000000, "没开自动清零的，调度器也不能碰");

    console.log("OK");
    await runtime.closeDatabase();
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
