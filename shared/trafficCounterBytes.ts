/**
 * 上报进来的字节数怎么当真。
 *
 * Agent 报的是两次采样的差值。机器重启、计数器回绕、插件自己算错，都会让这个差值
 * 变成负数、NaN 或者一个天文数字。入库那一层早就把它洗过一遍了（负数归零、上限
 * 截到安全整数），可**计费和配额**这一路用的是没洗过的原始值 —— 于是同一次上报，
 * 历史明细里记 9 PB，用户的已用流量却是 1e21：两个数对不上，而且后者一旦写进去，
 * 这个租户的配额永远是超的，名下所有转发被自动停掉。
 *
 * 所以洗一次，两边共用。宁可少算（负数当 0），也不能让一次坏上报把账户废掉。
 */
export function normalizeTrafficCounterBytes(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.min(Math.floor(num), Number.MAX_SAFE_INTEGER);
}

/** 连接数同理：负数和小数都不该出现在计数里。 */
export function normalizeTrafficCounterConnections(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.min(Math.floor(num), Number.MAX_SAFE_INTEGER);
}
