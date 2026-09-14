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

