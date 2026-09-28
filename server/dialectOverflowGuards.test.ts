import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import mysql from "mysql2/promise";

process.env.DATABASE_TYPE = "sqlite";

type Query = { sql: string; params?: unknown[] };

function mysqlPool(columnTypes: Record<string, string>) {
  const queries: Query[] = [];
  const pool = {
    getConnection() {
      throw new Error("not used");
    },
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (sql.includes("information_schema.COLUMNS")) {
        return [Object.entries(columnTypes).map(([key, dataType]) => {
          const [tableName, columnName] = key.split(".");
          return { tableName, columnName, dataType };
        }), []];
      }
      return [[], []];
    },
    async execute() {
      return [[], []];
    },
  };
  return { pool, queries };
}

function postgresPool(columnTypes: Record<string, string>) {
  const queries: Query[] = [];
  const pool = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (sql.includes("information_schema.columns")) {
        return {
          rows: Object.entries(columnTypes).map(([key, dataType]) => {
            const [tableName, columnName] = key.split(".");
            return { tableName, columnName, dataType };
          }),
        };
      }
      return { rows: [] };
    },
  };
  return { pool, queries };
}

test("累加的 connections 建成 BIGINT，老库上还是 INT 的列只升一次", async () => {
  const { ensureDatabaseSchema, getDatabaseTableDefs } = await import("./dbSchema");
  for (const table of ["user_traffic_counters", "forward_rule_traffic_counters"]) {
    const column = getDatabaseTableDefs().find((def) => def.name === table)?.columns.find((col) => col.name === "connections");
    assert.equal(column?.type, "bigint", table);
  }

  // MySQL：一张表还是 INT，另一张已经升过了 —— 只改还是 INT 的那张，约束原样带上。
  const mysqlLegacy = mysqlPool({
    "user_traffic_counters.connections": "int",
    "forward_rule_traffic_counters.connections": "bigint",
  });
  await ensureDatabaseSchema(mysqlLegacy.pool as any);
  const create = mysqlLegacy.queries.find((entry) => entry.sql.startsWith("CREATE TABLE IF NOT EXISTS `user_traffic_counters`"));
  assert.match(create?.sql || "", /`connections` BIGINT NOT NULL DEFAULT 0/);
  const mysqlModifies = mysqlLegacy.queries.filter((entry) => /MODIFY COLUMN `connections`/.test(entry.sql)).map((entry) => entry.sql);
  assert.deepEqual(mysqlModifies, ["ALTER TABLE `user_traffic_counters` MODIFY COLUMN `connections` BIGINT NOT NULL DEFAULT 0"]);

  // 已经全是 BIGINT：不再动表（MODIFY 会整表重写）。
  const mysqlCurrent = mysqlPool({
    "user_traffic_counters.connections": "bigint",
    "forward_rule_traffic_counters.connections": "bigint",
  });
  await ensureDatabaseSchema(mysqlCurrent.pool as any);
  assert.equal(mysqlCurrent.queries.some((entry) => /MODIFY COLUMN `connections`/.test(entry.sql)), false);

  // PostgreSQL 同理：ALTER COLUMN ... TYPE BIGINT，只在还是 integer 时执行。
  const pgLegacy = postgresPool({
    "user_traffic_counters.connections": "integer",
    "forward_rule_traffic_counters.connections": "integer",
  });
  await ensureDatabaseSchema(pgLegacy.pool as any);
  const pgCreate = pgLegacy.queries.find((entry) => entry.sql.startsWith('CREATE TABLE IF NOT EXISTS "forward_rule_traffic_counters"'));
  assert.match(pgCreate?.sql || "", /"connections" BIGINT NOT NULL DEFAULT 0/);
  assert.deepEqual(
    pgLegacy.queries.filter((entry) => /ALTER COLUMN "connections"/.test(entry.sql)).map((entry) => entry.sql),
    [
      'ALTER TABLE "user_traffic_counters" ALTER COLUMN "connections" TYPE BIGINT',
      'ALTER TABLE "forward_rule_traffic_counters" ALTER COLUMN "connections" TYPE BIGINT',
    ],
  );
  const pgCurrent = postgresPool({
    "user_traffic_counters.connections": "bigint",
    "forward_rule_traffic_counters.connections": "bigint",
  });
  await ensureDatabaseSchema(pgCurrent.pool as any);
  assert.equal(pgCurrent.queries.some((entry) => /ALTER COLUMN "connections"/.test(entry.sql)), false);
});

test("MySQL 上可能超过 64KB 的正文和插件数据列用 LONGTEXT，老库的 TEXT 会被升上去", async () => {
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const { pool, queries } = mysqlPool({});
  await ensureDatabaseSchema(pool as any);
  for (const expected of [
    "ALTER TABLE `announcements` MODIFY COLUMN `content` LONGTEXT NOT NULL",
    "ALTER TABLE `plugin_store_sources` MODIFY COLUMN `itemsJson` LONGTEXT NULL",
    "ALTER TABLE `plugin_assets` MODIFY COLUMN `content` LONGTEXT NULL",
    "ALTER TABLE `plugin_agent_states` MODIFY COLUMN `dataJson` LONGTEXT NULL",
    "ALTER TABLE `plugin_agent_states` MODIFY COLUMN `output` LONGTEXT NULL",
  ]) {
    assert.equal(queries.some((entry) => entry.sql === expected), true, expected);
  }
});

test("Agent 输出按 UTF-8 字节截断，不留半个字", async () => {
  const { truncateUtf8Bytes } = await import("./repositories/pluginRepository");
  assert.equal(truncateUtf8Bytes("abc", 10), "abc");
  assert.equal(truncateUtf8Bytes("中文字", 7), "中文");
  assert.equal(truncateUtf8Bytes("中文字", 6), "中文");
  assert.equal(truncateUtf8Bytes("a😀b", 4), "a");
  const output = truncateUtf8Bytes("中".repeat(64 * 1024), 64 * 1024);
  assert.ok(Buffer.byteLength(output, "utf8") <= 64 * 1024);
  assert.equal(output, "中".repeat(Math.floor(64 * 1024 / 3)));
});

test("x-request-id 只留安全字符并截到审计列宽", async () => {
  const { sanitizeAuditRequestId } = await import("./configAudit");
  assert.equal(sanitizeAuditRequestId("req-1.2_3"), "req-1.2_3");
  assert.equal(sanitizeAuditRequestId("a".repeat(200))?.length, 64);
  assert.equal(sanitizeAuditRequestId("<script>alert(1)</script>"), "scriptalert1script");
  assert.equal(sanitizeAuditRequestId(["first", "second"]), "first");
  assert.equal(sanitizeAuditRequestId("   "), undefined);
  assert.equal(sanitizeAuditRequestId(undefined), undefined);
});

test("MySQL 连接限住预处理语句缓存，mysql2 的 LRU 才会回收", async () => {
  const { MYSQL_MAX_PREPARED_STATEMENTS } = await import("./dbRuntime");
  // 32 条连接（连接池上限）也不能顶满服务端默认的 max_prepared_stmt_count（16382）。
  assert.ok(MYSQL_MAX_PREPARED_STATEMENTS * 32 < 16382);
  const pool = mysql.createPool({ host: "127.0.0.1", user: "forwardx", maxPreparedStatements: MYSQL_MAX_PREPARED_STATEMENTS });
  try {
    assert.equal((pool as any).pool.config.connectionConfig.maxPreparedStatements, MYSQL_MAX_PREPARED_STATEMENTS);
  } finally {
    await pool.end();
  }
});

test("SQLite：事务里的审计提交后才写，回滚就不写；线路切换事件返回自增 id", async () => {
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const audit = await import("./configAudit");
  const rules = await import("./repositories/forwardRuleRepository");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-dialect-guards-"));
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "panel.db") } });
    await ensureDatabaseSchema();
    const count = async () => Number((await runtime.queryRaw<{ n: number }>('SELECT COUNT(*) AS n FROM "config_audit_events"'))[0]?.n || 0);

    await audit.runWithConfigAuditContext({ source: "test", requestId: `${"x".repeat(100)}<>` }, async () => {
      await runtime.withDatabaseTransaction(async () => {
        const revision = await audit.recordConfigAuditEvent({ resourceType: "tunnel", resourceId: 7, action: "create", after: { id: 7 } });
        assert.equal(revision, 0);
        assert.equal(await count(), 0, "提交前不应写审计");
      });
    });
    assert.equal(await count(), 1);
    const [row] = await runtime.queryRaw<{ requestId: string }>('SELECT "requestId" FROM "config_audit_events"');
    assert.equal(row.requestId, "x".repeat(64));

    await assert.rejects(runtime.withDatabaseTransaction(async () => {
      await audit.recordConfigAuditEvent({ resourceType: "tunnel", resourceId: 8, action: "create", after: { id: 8 } });
      throw new Error("rollback");
    }), /rollback/);
    assert.equal(await count(), 1, "回滚的事务不应留下审计");

    // 事务外照旧立即写，返回 revision。
    assert.ok(await audit.recordConfigAuditEvent({ resourceType: "tunnel", resourceId: 9, action: "create", after: { id: 9 } }) > 0);

    const first = await rules.insertForwardRuleRouteEvent({ ruleId: 1, kind: "switch", latencyMs: 1e12, score: -1e12 });
    const second = await rules.insertForwardRuleRouteEvent({ ruleId: 1, kind: "switch" });
    assert.ok(first > 0);
    assert.equal(second, first + 1);
    const [event] = await runtime.queryRaw<{ latencyMs: number; score: number }>(
      'SELECT "latencyMs", "score" FROM "forward_rule_route_events" WHERE "id" = ?',
      [first],
    );
    assert.equal(Number(event.latencyMs), 2147483647);
    assert.equal(Number(event.score), -2147483648);
  } finally {
    await runtime.closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
