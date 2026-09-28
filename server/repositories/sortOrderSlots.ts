import { executeRaw, withDatabaseTransaction } from "../dbRuntime";
import { quoteIdentifier } from "../dbCompat";

const SORT_ORDER_UPDATE_CHUNK = 200;

/**
 * 拖拽排序的落库：把这一页被拖过的行，在它们**原有的 sortOrder 位置**里重新排座。
 *
 * 以前写的是 sortOrder = startIndex + i，默认整张列表的 sortOrder 是 0、1、2… 连续的。
 * 实际上不是：删过行就有空洞（第二页从 7 开始，写成 5、6… 会插到第一页里去）；
 * 老数据全是 0（写成 20、21… 之后这一页整体沉到列表最底）。
 *
 * 现在的做法：
 * 1. 读出同一个列表范围（loadScope，已按列表的展示顺序排好）里全部行的 sortOrder；
 * 2. 范围里有并列值（典型是老数据全 0，或多个用户各自从 0 编号后在管理员的总列表里撞号）
 *    就先按当前展示顺序整体重编成 0..n-1 —— 展示顺序不变，只是把并列拆开，
 *    否则在一堆相同的值之间换座什么也换不动；
 * 3. 取被拖的这几行现有的值，升序排好，按拖拽后的新顺序依次分给它们。
 *    这几行占的「座位」集合不变，所以不会跑到别的页、也不会和没拖的行交叉。
 * 整个读改写在一个事务里做，中途失败不会留下半套顺序。
 */
export async function reorderWithinSortOrderScope(options: {
  table: string;
  orderedIds: number[];
  loadScope: () => Promise<Array<{ id: unknown; sortOrder: unknown }>>;
}) {
  const { table, orderedIds } = options;
  await withDatabaseTransaction(async () => {
    const scope = (await options.loadScope()).map((row) => ({
      id: Number(row.id),
      sortOrder: Math.floor(Number(row.sortOrder) || 0),
    }));
    const stored = new Map(scope.map((row) => [row.id, row.sortOrder]));
    const next = new Map(stored);
    const hasTies = new Set(scope.map((row) => row.sortOrder)).size !== scope.length;
    if (hasTies) scope.forEach((row, index) => next.set(row.id, index));
    const slots = orderedIds.map((id) => next.get(id));
    if (slots.some((slot) => slot === undefined)) throw new Error("排序数据已变化，请刷新后重试");
    (slots as number[]).sort((left, right) => left - right).forEach((slot, index) => next.set(orderedIds[index], slot));
    const changed = scope
      .filter((row) => next.get(row.id) !== row.sortOrder)
      .map((row) => ({ id: row.id, value: next.get(row.id) as number }));
    const q = quoteIdentifier;
    for (let index = 0; index < changed.length; index += SORT_ORDER_UPDATE_CHUNK) {
      const chunk = changed.slice(index, index + SORT_ORDER_UPDATE_CHUNK);
      await executeRaw(
        `UPDATE ${q(table)} SET ${q("sortOrder")} = CASE ${q("id")} ${chunk.map(() => "WHEN ? THEN ?").join(" ")} ELSE ${q("sortOrder")} END WHERE ${q("id")} IN (${chunk.map(() => "?").join(", ")})`,
        [...chunk.flatMap((item) => [item.id, item.value]), ...chunk.map((item) => item.id)],
      );
    }
  });
}
