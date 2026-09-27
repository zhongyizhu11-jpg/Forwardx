/**
 * 把「按小时的桶」摊成过去 N 个整点小时的数组（画小走势线用）。
 *
 * 第 i 格是 `now - N + i` 那个整点小时；正在走的这个小时并进最后一格，刚发生的量不会被截掉；
 * 比 N 小时更早的桶丢掉。没有数据的格是 0。规则卡、页头、链路卡的走势线都用它，
 * 三处的时间轴才是同一根。
 */
export function hourlySlots<T>(
  rows: readonly T[] | null | undefined,
  read: (row: T) => { at: number | string | Date; value: number },
  hours = 24,
  now = Date.now(),
): number[] {
  const slots = new Array<number>(hours).fill(0);
  if (!rows) return slots;
  const hourMs = 60 * 60 * 1000;
  const firstHour = Math.floor(now / hourMs) - hours;
  for (const row of rows) {
    const { at, value } = read(row);
    const time = at instanceof Date ? at.getTime() : new Date(at).getTime();
    if (!Number.isFinite(time)) continue;
    const index = Math.min(hours - 1, Math.floor(time / hourMs) - firstHour);
    if (index < 0) continue;
    slots[index] += Number.isFinite(value) ? value : 0;
  }
  return slots;
}
