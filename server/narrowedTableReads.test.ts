import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 三处「为了一个数字，把整张表读回来」换成窄查询，结果必须一模一样。
 *
 * 这一轮只做减法：countHostsByUserId 要和原来的 `(await getHosts(userId)).length`
 * 等值，findExistingHostIds 要和原来「整表读回来建 Set」等值，getNonAdminUserIds
 * 要和原来「getAllUsers() 再 filter 掉 admin」等值。等值靠的不是看着像 ——
 * 下面每一条都拿老写法当场算一遍，两边对。
 */
test("窄查询和原来的整表读结果一致", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-narrow-reads-"));
  const databasePath = path.join(directory, "narrow.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const hostRepo = await import(url("server/repositories/hostRepository.ts"));
    const userRepo = await import(url("server/repositories/userRepository.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, p = []) => runtime.executeRaw(sql, p);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, '张三', 'h', 'user')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (3, '李四', 'h', 'user')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (4, '第二个管理员', 'h', 'admin')");

    const host = (id, userId) => exec(
      "INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (?, ?, ?, 'slave', ?, ?)",
      [id, "h" + id, "127.0.0." + id, "t" + id, userId],
    );
    await host(10, 2);
    await host(11, 2);
    await host(12, 2);
    await host(20, 3);

    /* 一、数机器：和 「(await getHosts(userId)).length」 必须是同一个数。 */
    for (const userId of [1, 2, 3, 999]) {
      const legacy = (await hostRepo.getHosts(userId)).length;
      const narrow = await hostRepo.countHostsByUserId(userId);
      assert.equal(narrow, legacy, "用户 " + userId + " 的机器台数两种写法要一致");
    }
    assert.equal(await hostRepo.countHostsByUserId(2), 3, "张三名下 3 台");
    assert.equal(await hostRepo.countHostsByUserId(3), 1, "李四名下 1 台");
    assert.equal(await hostRepo.countHostsByUserId(999), 0, "没有机器的人是 0，不是抛错");
    // 脏值不能变成「全表」：0/负数/小数都当成没有。自助配额是拿这个数拦人的。
    for (const bad of [0, -1, 1.5, NaN]) {
      assert.equal(await hostRepo.countHostsByUserId(bad), 0, "脏用户 id 只能是 0：" + String(bad));
    }

    /* 二、校验主机存在：和「整表读回来建 Set」必须选出同一批。 */
    const legacyExisting = async (ids) => {
      const all = await hostRepo.getHosts();
      const present = new Set(all.map((row) => Number(row.id)));
      return ids.filter((id) => present.has(id)).sort((a, b) => a - b);
    };
    for (const ids of [[10, 11], [10, 99], [99], [], [12, 20, 10]]) {
      const narrow = Array.from(await hostRepo.findExistingHostIds(ids)).sort((a, b) => a - b);
      assert.deepEqual(narrow, await legacyExisting(ids), "id 组 [" + ids.join(",") + "] 两种写法要选出同一批");
    }
    // 重复 id 不该影响判断，脏 id 直接丢掉（不能当成「存在」放过去）。
    const messy = await hostRepo.findExistingHostIds([10, 10, 0, -3, NaN, 11]);
    assert.deepEqual(Array.from(messy).sort((a, b) => a - b), [10, 11], "重复去掉、脏值丢掉");

    /* 三、非管理员 id：和「getAllUsers() 再 filter」必须是同一批人。 */
    const all = await userRepo.getAllUsers();
    const legacyIds = all
      .filter((row) => String(row.role || "user") !== "admin")
      .map((row) => Number(row.id))
      .sort((a, b) => a - b);
    const narrowIds = (await userRepo.getNonAdminUserIds()).slice().sort((a, b) => a - b);
    assert.deepEqual(narrowIds, legacyIds, "非管理员这一批人两种写法要一致");
    assert.deepEqual(narrowIds, [2, 3], "两个管理员都要被滤掉，包括后加的那个");

    /*
      对账扫描漏掉一个人，等于这个人的转发权限对不上账还没人发现 —— 所以
      「多滤了」比「少滤了」更危险，这里把管理员这一条单独钉死。
    */
    await exec("UPDATE users SET role = 'user' WHERE id = 4");
    const afterDemote = (await userRepo.getNonAdminUserIds()).slice().sort((a, b) => a - b);
    assert.deepEqual(afterDemote, [2, 3, 4], "降级成普通用户后要立刻进对账范围");

    /*
      老写法是 String(role || "user") !== "admin"，空串会被兜成 "user" 从而算进来；
      SQL 的 role <> 'admin' 对空串同样为真，两边一致。role 这一列是 NOT NULL
      DEFAULT 'user'，所以不存在 NULL <> 'admin' 判 NULL、把人整个漏掉的那种情况。
    */
    await exec("UPDATE users SET role = '' WHERE id = 3");
    const blankRole = (await userRepo.getNonAdminUserIds()).slice().sort((a, b) => a - b);
    assert.ok(blankRole.includes(3), "role 是空串的老数据也得进对账范围，不能悄悄漏人");

    console.log("NARROW_READS_OK");
    await runtime.closeDatabase().catch(() => undefined);
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, NODE_ENV: "test" },
      timeout: 120000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /NARROW_READS_OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
