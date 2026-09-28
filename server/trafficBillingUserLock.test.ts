import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 计费前锁用户行：以前一个用户一条语句，一次上报涉及几百个用户就是几百次往返（而且
 * 全程握着事务）。现在按 500 个一批、一条 IN (...) ORDER BY id 锁住。
 *
 * 这里钉三件事：条数按批数走而不是按人数走、批内按 id 升序（加锁顺序就是它）、
 * 少了任何一个用户照旧报 User not found。
 */
test("计费锁用户行按批一条语句，缺人照旧报错", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-billing-lock-"));
  const databasePath = path.join(directory, "lock.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const Database = (await import("better-sqlite3")).default;
    const originalPrepare = Database.prototype.prepare;
    let statements = [];
    Database.prototype.prepare = function (sql) {
      statements.push(String(sql));
      return originalPrepare.call(this, sql);
    };

    const url = (f) => pathToFileURL(path.join(process.cwd(), f)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const billing = await import(url("server/repositories/trafficBillingRepository.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    for (let id = 1; id <= 1200; id++) {
      await runtime.executeRaw("INSERT INTO users (id, username, password, role) VALUES (?, ?, 'h', 'user')", [id, "u" + id]);
    }
    const locks = () => statements.filter((sql) => /FROM\s+"users"\s+WHERE\s+"id"\s+IN/i.test(sql));

    statements = [];
    await runtime.withDatabaseTransaction(() => billing.lockTrafficBillingUserRows([3, 1, 2, 2, 0, -1]));
    assert.equal(locks().length, 1, "三个用户一条语句");
    assert.match(locks()[0], /ORDER BY "id"/, "批内按 id 升序上锁");

    statements = [];
    const many = Array.from({ length: 1200 }, (_, index) => 1200 - index);
    await runtime.withDatabaseTransaction(() => billing.lockTrafficBillingUserRows(many));
    assert.equal(locks().length, 3, "1200 个用户按 500 一批是三条");

    statements = [];
    await runtime.withDatabaseTransaction(() => billing.lockTrafficBillingUserRows([]));
    assert.equal(locks().length, 0, "没有用户就不打库");

    await assert.rejects(
      () => runtime.withDatabaseTransaction(() => billing.lockTrafficBillingUserRows([1, 99999])),
      /User not found/,
    );
    await assert.rejects(
      () => runtime.withDatabaseTransaction(() => billing.lockTrafficBillingUserRows([...many, 5000])),
      /User not found/,
      "缺的人落在最后一批也要发现",
    );
    console.log("LOCK_OK");
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
    assert.match(result.stdout, /LOCK_OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
