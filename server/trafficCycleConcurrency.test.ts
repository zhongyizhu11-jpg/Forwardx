import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 流量累加与周期重置在并发下的三条性质。
 *
 * 这三条现在都成立，写下来是**防回退**：它们靠的是具体写法，而那几种写法看上去
 * 都「可以顺手改得更好读」——
 *
 *   1. 累加是一条 `trafficUsed = trafficUsed + ?` 的原子 SQL。改成「先读出来、
 *      加一下、再写回去」会读起来更清楚，也会在并发下丢更新：一台机器几十条
 *      转发同时上报，少算的那部分永远补不回来。
 *   2. 重置是一条带 `lastAutoTrafficReset < boundary` 条件的 UPDATE，所以幂等。
 *      这个任务**每小时跑一次**，不幂等的话重置日当天会清零二十几次 —— 当天的
 *      用量每小时归零，配额形同虚设。
 *   3. 重置和上报撞在一起时，字节要么算进旧周期（跟着被清掉），要么算进新周期。
 *      不能出现负数、不能把旧周期的量留在新周期里。
 */
test("SQLite 流量累加与周期重置在并发下不丢、不重、不串周期", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-traffic-conc-"));
  const databasePath = path.join(directory, "traffic-conc.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const users = await import(url("server/repositories/userRepository.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'tenant', 'hash', 'user')");
    const used = async () => Number((await query('SELECT "trafficUsed" AS u FROM users WHERE id = 1'))[0].u);

    const MB = 1024 * 1024;
    const BURST = 200;

    /** 一、并发累加不丢。 */
    await Promise.all(Array.from({ length: BURST }, () => users.addUserTraffic(1, MB)));
    assert.equal(
      await used(),
      BURST * MB,
      BURST + " 次并发累加之后对不上 —— 累加不再是原子的，并发上报会丢更新",
    );

    /** 二、同一个周期边界重复触发只生效一次。 */
    const now = new Date();
    const boundary = new Date(now.getTime() - 3600 * 1000);
    await exec('UPDATE users SET "trafficUsed" = ? WHERE id = 1', [500 * MB]);
    const outcomes = [];
    for (let i = 0; i < 5; i += 1) {
      outcomes.push(await users.resetUserTrafficForCycle(1, boundary, now));
    }
    assert.deepEqual(
      outcomes,
      [true, false, false, false, false],
      "同一个边界重复触发不止生效一次 —— 这个任务每小时跑一次，重置日当天会清零二十几次",
    );
    assert.equal(await used(), 0);

    /** 三、重置与上报并发，不串周期也不出负数。 */
    await exec('UPDATE users SET "trafficUsed" = ?, "lastAutoTrafficReset" = NULL WHERE id = 1', [900 * MB]);
    const later = new Date(now.getTime() + 1000);
    const inflight = 100;
    await Promise.all([
      users.resetUserTrafficForCycle(1, boundary, later),
      ...Array.from({ length: inflight }, () => users.addUserTraffic(1, MB)),
    ]);
    const after = await used();
    assert.ok(after >= 0, "并发之后出现负数用量：" + after);
    assert.ok(
      after <= inflight * MB,
      "旧周期的 900MB 有一部分留在了新周期里（现在是 " + Math.round(after / MB) + "MB）",
    );

    console.log("OK");
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /OK/);
});
