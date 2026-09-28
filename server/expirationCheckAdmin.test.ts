import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 每小时一次的到期扫描不该拿管理员当「刚到期的用户」。
 *
 * 管理员设了到期时间、又过了期：setUserForwardAccess 本来就不会自动暂停管理员，
 * 他的 canAddRules 一直是 true，于是每小时都会被 getExpiredUsers 扫出来，再触发
 * 一次全量 Agent 刷新。setUserForwardAccess 也要能告诉调用方「这次什么都没变」，
 * 否则普通用户第二次被扫到时同样白刷一遍。
 */
test("到期扫描排除管理员；暂停转发权限只在真有变化时报告变化", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-expiration-admin-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const users = await import(url("server/repositories/userRepository.ts"));

      const past = Math.floor(Date.now() / 1000) - 3600;
      await runtime.executeRaw('INSERT INTO users (id, username, password, role, "canAddRules", "expiresAt") VALUES (1, ?, ?, ?, 1, ?)', ["admin", "h", "admin", past]);
      await runtime.executeRaw('INSERT INTO users (id, username, password, role, "canAddRules", "expiresAt") VALUES (2, ?, ?, ?, 1, ?)', ["u2", "h", "user", past]);

      const expired = (await users.getExpiredUsers()).map((user) => Number(user.id));
      assert.deepEqual(expired, [2], "管理员不会被自动暂停，扫出来只会每小时白刷一遍");

      assert.equal(await users.setUserForwardAccess(1, false, "expired"), false, "管理员的自动暂停被跳过，什么都没变");
      assert.equal(await users.setUserForwardAccess(2, false, "expired"), true, "第一次暂停：权限确实被收了");
      assert.equal(await users.setUserForwardAccess(2, false, "expired"), false, "再暂停一次：什么都没变，不该触发 Agent 刷新");
      assert.deepEqual((await users.getExpiredUsers()).map((user) => Number(user.id)), []);
      assert.equal(await users.setUserForwardAccess(2, true), true, "恢复：权限变了");
      assert.equal(await users.setUserForwardAccess(2, true), false);
      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "expiration.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
