import { executeRaw, getDatabaseKind, rawAffectedRows } from "../dbRuntime";
import { quoteIdentifier } from "../dbCompat";

const SQLITE_HISTORY_DELETE_BATCH_SIZE = 2_000;
const EXTERNAL_HISTORY_DELETE_BATCH_SIZE = 5_000;

async function yieldToEventLoop() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * 按时间列分批删除过期历史行，返回删掉的总行数。
 *
 * 三种方言都分批：SQLite 每批 2000 行（better-sqlite3 是同步的，批与批之间让出事件循环，
 * 心跳和面板读取才插得进来）；MySQL/PostgreSQL 每批 5000 行 —— 原来是一条 DELETE 删到底，
 * 几十万行过期明细在一个事务里长时间持有行锁、撑大 undo/WAL，同表的上报写入全被堵住。
 * 删到不足一批为止，最终删掉的行与一次性删完完全相同。
 *
 * orderColumn：每批按哪一列挑最老的行，默认就是时间列（历史表的时间列都有索引）。
 * 时间列没有索引的表（例如 auth_sessions.revokedAt、config_audit_events.createdAt）
 * 传 "id"，走主键顺序，免得每一批都把全部候选行重新排一次序。
 */
export async function deleteExpiredHistoryRows(
  tableName: string,
  timeColumn: string,
  cutoff: number,
  options: { whereSql?: string; whereParams?: unknown[]; orderColumn?: string } = {},
) {
  const q = quoteIdentifier;
  const whereSql = String(options.whereSql || "").trim();
  const prefix = whereSql ? `${whereSql} AND ` : "";
  const whereParams = options.whereParams || [];
  const orderColumn = options.orderColumn || timeColumn;
  // SQLite 沿用原来的 (时间, id) 顺序；MySQL/PostgreSQL 只按时间列排，才能直接顺着
  // (时间, …) 索引取前 5000 行，而不是每批都把全部过期行 filesort 一遍。
  const sqliteOrderSql = orderColumn === "id"
    ? `${q("id")} ASC`
    : `${q(orderColumn)} ASC, ${q("id")} ASC`;
  const externalOrderSql = `${q(orderColumn)} ASC`;

  const kind = getDatabaseKind();
  if (kind !== "sqlite") {
    let deleted = 0;
    while (true) {
      const result = kind === "mysql"
        // MySQL 单表 DELETE 支持 ORDER BY ... LIMIT；带 ORDER BY 才是确定的，
        // 语句级复制下不会被判成不安全语句。
        ? await executeRaw(
          `DELETE FROM ${q(tableName)}
            WHERE ${prefix}${q(timeColumn)} < ?
            ORDER BY ${externalOrderSql}
            LIMIT ${EXTERNAL_HISTORY_DELETE_BATCH_SIZE}`,
          [...whereParams, cutoff],
        )
        // PostgreSQL 的 DELETE 不支持 LIMIT，用主键子查询圈出这一批。
        : await executeRaw(
          `DELETE FROM ${q(tableName)}
            WHERE ${q("id")} IN (
              SELECT ${q("id")}
                FROM ${q(tableName)}
               WHERE ${prefix}${q(timeColumn)} < ?
               ORDER BY ${externalOrderSql}
               LIMIT ${EXTERNAL_HISTORY_DELETE_BATCH_SIZE}
            )`,
          [...whereParams, cutoff],
        );
      const affected = rawAffectedRows(result);
      deleted += affected;
      if (affected < EXTERNAL_HISTORY_DELETE_BATCH_SIZE) return deleted;
      await yieldToEventLoop();
    }
  }

  let deleted = 0;
  while (true) {
    const result = await executeRaw(
      `DELETE FROM ${q(tableName)}
        WHERE ${q("id")} IN (
          SELECT ${q("id")}
            FROM ${q(tableName)}
           WHERE ${prefix}${q(timeColumn)} < ?
           ORDER BY ${sqliteOrderSql}
           LIMIT ?
        )`,
      [...whereParams, cutoff, SQLITE_HISTORY_DELETE_BATCH_SIZE],
    );
    const affected = rawAffectedRows(result);
    deleted += affected;
    if (affected < SQLITE_HISTORY_DELETE_BATCH_SIZE) return deleted;
    // better-sqlite3 is synchronous. Releasing the connection lock between
    // bounded batches lets heartbeats and panel reads run during cleanup.
    await yieldToEventLoop();
  }
}
