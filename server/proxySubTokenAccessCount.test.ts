import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 「已拉取 N 次」这个数得是真的。
 *
 * 一条订阅地址同时被好几个客户端拉是常态 —— 一个人手机、电脑、路由器各刷各的，
 * 客户端默认十二小时一轮，起床时间又差不多，几路请求撞在同一秒里很正常。
 *
 * 原来的写法是先把当前次数读出来、加一、再写回去。几路请求读到的是同一个旧值，
 * 写回的也是同一个新值：二十次拉取，数字只涨一次。而商家看这个数就是为了回答
 * 「客户端到底拉没拉过、拉得勤不勤」—— 被吞掉的恰恰是最该看见的那一部分，
 * 而且是越活跃的租户吞得越狠。
 *
 * 加法交给数据库自己做，这一条才立得住。
 */
test("SQLite 同时拉订阅，每一次都要记进拉取次数", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sub-count-"));
  const databasePath = path.join(directory, "sub-count.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const subs = await import(url("server/repositories/proxySubscriptionRepository.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);
    const countOf = async (id) =>
      Number((await query('SELECT "accessCount" FROM "proxy_sub_tokens" WHERE "id" = ?', [id]))[0].accessCount || 0);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'owner', 'hash', 'user')");
    await exec("INSERT INTO proxy_sub_tokens (id, userId, name, token, defaultFormat, isEnabled) VALUES (1, 1, '手机', 'tok-a', 'base64', 1)");
    await exec("INSERT INTO proxy_sub_tokens (id, userId, name, token, defaultFormat, isEnabled) VALUES (2, 1, '电脑', 'tok-b', 'base64', 1)");

    // 一个个来的时候本来就没问题，先把基准立住。
    for (let i = 0; i < 3; i += 1) await subs.recordProxySubTokenAccess(1, { ip: "1.1.1.1" });
    assert.equal(await countOf(1), 3, "挨个拉三次就该是三次");

    // 二十路同时拉同一条地址。
    const N = 20;
    await Promise.all(Array.from({ length: N }, (_unused, i) =>
      subs.recordProxySubTokenAccess(1, { ip: "10.0.0." + i, userAgent: "client-" + i }),
    ));
    assert.equal(
      await countOf(1),
      3 + N,
      "同时拉的那些不能互相把对方的记录盖掉",
    );

    // 别人的地址不会被顺带加上。
    assert.equal(await countOf(2), 0, "只该加自己这一行");

    // 并发之后这一行仍然是「现在能拉」的样子：上一次被拒的痕迹清干净了。
    await exec("UPDATE proxy_sub_tokens SET lastFailureAt = ?, lastFailureReason = 'not-eligible' WHERE id = 1",
      [Math.floor(Date.now() / 1000)]);
    await Promise.all(Array.from({ length: 5 }, () => subs.recordProxySubTokenAccess(1, { ip: "1.1.1.1" })));
    const row = (await query('SELECT "accessCount", "lastAccessAt", "lastFailureReason" FROM "proxy_sub_tokens" WHERE "id" = 1', []))[0];
    assert.equal(Number(row.accessCount || 0), 3 + N + 5);
    assert.equal(row.lastFailureReason, null, "拉成功了就该把上一次被拒清掉");
    assert.ok(Number(row.lastAccessAt || 0) > 0, "最后一次拉取的时间也得落下来");

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
