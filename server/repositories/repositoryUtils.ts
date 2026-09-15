/**
 * 从库里读回来的布尔值统一在这里判。
 *
 * SQLite 存 0/1、PostgreSQL 存 true/false、裸 SQL 回来的还可能是字符串 "1"/"true"，
 * 所以六个地方各写了一份判断，分两种写法：tunnels 路由 / forwardGroup 仓库 /
 * tunnel 仓库是这一份，linkAccessView / ruleResourceAuthorization / rules.crud
 * 那三处少了 typeof 那道闸、直接 String(value) 比对。两者对库里真实出现的值
 * （0/1、true/false、"0"/"1"/"true"/"false"、null、空串）结果完全一致，只在
 * 传进一个自定义 toString 的对象时才分岔 —— 那种值不会从数据库列里来。
 *
 * 空值走 fallback 而不是一律 false ——「这一列还没设过」和「设成了关」是两回事，
 * 后者不该被前者盖掉。
 */
export function dbBool(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

export { epochSeconds, sqlBool } from "../dbCompat";

export function clampPositiveInt(value: unknown, fallback: number, max: number) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export function addMonthsClamped(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  const day = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + months);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, lastDay));
  return next;
}


/**
 * 按给定的 id 顺序重排一张表的 sortOrder，两个仓库原来各存一份（探测服务、主机分组），
 * 371 token 一字不差，只差表名和错误里的那个名词。
 *
 * 几个不显眼但要紧的点，合并时原样保留：
 *
 * - **先校验再写**：把 id 列表整体查一遍，数量对不上就整个拒绝。少了这一步，
 *   一个夹带了别人 id 的排序请求会把别人的行也改掉 —— 拖拽排序看起来无害，
 *   但它是个批量写接口。
 * - **重复 id 直接判无效**：`new Set(ids).size !== ids.length`。有重复说明前端
 *   状态已经乱了，照着写会把两行挤到同一个位置。
 * - **userId 可选**：管理员传空、租户必须带上，由调用方决定，这里不猜。
 */
export async function reorderRowsBySortOrder(options: {
  table: string;
  ids: number[];
  userId?: number;
  /** 校验没过时报给人的话，要带上这张表的名词，例如「服务」「分组」。 */
  notFoundMessage: string;
  deps: {
    getDb: () => Promise<unknown>;
    queryRaw: <T>(sql: string, params?: any[]) => Promise<T[]>;
    executeRaw: (sql: string, params?: any[]) => Promise<unknown>;
    quoteIdentifier: (id: string) => string;
    inList: (ids: number[]) => { sql: string; params: any[] };
  };
}) {
  const { table, ids, userId, notFoundMessage, deps } = options;
  const db = await deps.getDb();
  if (!db) throw new Error("Database not available");
  const orderedIds = Array.from(ids || [])
    .map((id) => Math.floor(Number(id)))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (orderedIds.length === 0 || new Set(orderedIds).size !== orderedIds.length) throw new Error("排序数据无效");
  const q = deps.quoteIdentifier;
  const list = deps.inList(orderedIds);
  const params: any[] = [...list.params];
  let userWhere = "";
  if (userId) {
    userWhere = ` AND ${q("userId")} = ?`;
    params.push(userId);
  }
  const rows = await deps.queryRaw<{ id: number }>(
    `SELECT ${q("id")} FROM ${q(table)} WHERE ${q("id")} IN ${list.sql}${userWhere}`,
    params,
  );
  if (rows.length !== orderedIds.length) throw new Error(notFoundMessage);
  const now = Math.floor(Date.now() / 1000);
  for (const [index, id] of orderedIds.entries()) {
    await deps.executeRaw(
      `UPDATE ${q(table)}
          SET ${q("sortOrder")} = ?, ${q("updatedAt")} = ?
        WHERE ${q("id")} = ?`,
      [index, now, id],
    );
  }
}
