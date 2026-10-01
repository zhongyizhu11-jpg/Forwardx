import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("SQLite reuses prepared statements safely and sets connection pragmas", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const { hosts } = await import("../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-stmt-cache-"));
  const databasePath = path.join(directory, "cache.db");
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: databasePath } });
    await ensureDatabaseSchema();
    const sqlite = runtime.requireSqlite();

    // 连接参数都显式设了
    assert.equal(sqlite.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(sqlite.pragma("synchronous", { simple: true }), 1);
    assert.equal(sqlite.pragma("busy_timeout", { simple: true }), 5000);
    assert.equal(sqlite.pragma("cache_size", { simple: true }), -16000);
    assert.equal(sqlite.pragma("temp_store", { simple: true }), 2);
    assert.equal(sqlite.pragma("mmap_size", { simple: true }), 134217728);
    assert.equal(sqlite.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(await runtime.optimizeSqliteDatabase({ startup: true }), true);
    assert.equal(await runtime.optimizeSqliteDatabase(), true);

    await runtime.executeRaw(
      "INSERT INTO hosts (id, name, ip, \"hostType\", \"agentToken\", \"userId\") VALUES (1, 'a', '10.0.0.1', 'slave', 'tok-a', 1), (2, 'b', '10.0.0.2', 'slave', 'tok-b', 1)",
    );

    // 同一条 SQL 只编译一次，参数不同结果各自正确
    const byToken = 'SELECT "id", "name" FROM "hosts" WHERE "agentToken" = ?';
    const before = runtime.getSqliteStatementCacheSize();
    assert.deepEqual(await runtime.queryRaw(byToken, ["tok-a"]), [{ id: 1, name: "a" }]);
    assert.deepEqual(await runtime.queryRaw(byToken, ["tok-b"]), [{ id: 2, name: "b" }]);
    assert.equal(runtime.getSqliteStatementCacheSize(), before + 1);

    // 同一条语句同时被 Drizzle（数组行）和 queryRaw（对象行）用：raw 模式每次都显式设
    const db = await runtime.getDb();
    const drizzleQuery = db.select({ id: hosts.id, name: hosts.name }).from(hosts).where(eq(hosts.agentToken, "tok-a"));
    const shared = drizzleQuery.toSQL();
    assert.deepEqual(await drizzleQuery, [{ id: 1, name: "a" }]);
    assert.deepEqual(await runtime.queryRaw(shared.sql, shared.params), [{ id: 1, name: "a" }]);
    assert.deepEqual(await drizzleQuery, [{ id: 1, name: "a" }]);
    assert.deepEqual(await db.select({ id: hosts.id }).from(hosts).where(eq(hosts.agentToken, "tok-b")).get(), { id: 2 });

    // 并发、事务里复用同一条语句
    const concurrent = await Promise.all(Array.from({ length: 50 }, (_, index) => runtime.queryRaw(byToken, [index % 2 ? "tok-b" : "tok-a"])));
    concurrent.forEach((rows, index) => assert.equal(rows[0].id, index % 2 ? 2 : 1));
    await runtime.withDatabaseTransaction(async () => {
      await runtime.executeRaw('UPDATE "hosts" SET "name" = ? WHERE "id" = ?', ["a2", 1]);
      assert.deepEqual(await runtime.queryRaw(byToken, ["tok-a"]), [{ id: 1, name: "a2" }]);
    });

    // 表结构变了，缓存里的 SELECT * 也要看到新列
    const selectAll = 'SELECT * FROM "rule_cache_probe" WHERE "id" = ?';
    await runtime.executeRaw('CREATE TABLE "rule_cache_probe" ("id" INTEGER PRIMARY KEY, "a" TEXT)');
    await runtime.executeRaw('INSERT INTO "rule_cache_probe" ("id", "a") VALUES (1, \'x\')');
    assert.deepEqual(await runtime.queryRaw(selectAll, [1]), [{ id: 1, a: "x" }]);
    await runtime.executeRaw('ALTER TABLE "rule_cache_probe" ADD COLUMN "b" TEXT DEFAULT \'y\'');
    assert.deepEqual(await runtime.queryRaw(selectAll, [1]), [{ id: 1, a: "x", b: "y" }]);

    // 超长 SQL（长 IN 列表）不进缓存
    const sizeBeforeLong = runtime.getSqliteStatementCacheSize();
    const ids = Array.from({ length: 2500 }, (_, index) => index + 1);
    const longRows = await runtime.queryRaw(`SELECT "id" FROM "hosts" WHERE "id" IN (${ids.map(() => "?").join(",")}) ORDER BY "id"`, ids);
    assert.deepEqual(longRows.map((row: any) => row.id), [1, 2]);
    assert.equal(runtime.getSqliteStatementCacheSize(), sizeBeforeLong);

    // 有上限
    for (let index = 0; index < 520; index += 1) await runtime.queryRaw(`SELECT ${index} AS "n"`);
    assert.equal(runtime.getSqliteStatementCacheSize(), 500);
    assert.deepEqual(await runtime.queryRaw(byToken, ["tok-b"]), [{ id: 2, name: "b" }]);

    // 有人替换了 prepare（测试数语句条数）时不走缓存，每条都经过它
    const originalPrepare = sqlite.prepare;
    let prepared = 0;
    sqlite.prepare = function (this: any, ...args: any[]) {
      prepared += 1;
      return (originalPrepare as any).apply(this, args);
    } as any;
    try {
      await runtime.queryRaw(byToken, ["tok-a"]);
      await runtime.queryRaw(byToken, ["tok-a"]);
      await db.select({ id: hosts.id }).from(hosts).where(eq(hosts.agentToken, "tok-a"));
    } finally {
      sqlite.prepare = originalPrepare;
    }
    assert.equal(prepared, 3);

    // 关闭 / 重连后缓存清空，新连接照常工作
    await runtime.closeDatabase();
    assert.equal(runtime.getSqliteStatementCacheSize(), 0);
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: databasePath } });
    assert.deepEqual(await runtime.queryRaw(byToken, ["tok-b"]), [{ id: 2, name: "b" }]);
    assert.equal(runtime.getSqliteStatementCacheSize(), 1);
  } finally {
    await runtime.closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
