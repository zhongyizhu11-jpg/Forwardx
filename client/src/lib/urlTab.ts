/**
 * 「这一页该打开哪个 tab」的判定。
 *
 * 抽出来是因为它原来藏在 useUrlTab 里，而那里读地址栏读错了：wouter 的
 * `useLocation()` 只给**路径**，不含 `?` 后面的部分，于是 `location.split("?")[1]`
 * 永远是空串 —— 整个 `?tab=xxx` 深链接功能从来没生效过，而且不会报错，只是默默
 * 回落到默认 tab。这种错只有把它摆成一个能断言的函数才拦得住。
 *
 * 优先级：地址栏 > 上次存的 > 默认。地址栏优先是因为它是**别人刚发给你的意图**
 * （一条跳转、一个分享出去的链接），比这台浏览器上次停在哪要新。
 */
export function pickTabValue<T extends string>(
  search: string,
  storedValue: string | null | undefined,
  values: readonly T[],
  defaultValue: T,
  queryKey = "tab",
): T {
  const allowed = new Set<string>(values);
  const coerce = (value: unknown): T | null => {
    const raw = String(value ?? "");
    return allowed.has(raw) ? (raw as T) : null;
  };
  const fromQuery = (() => {
    // 传进来的可能是 "?a=1"、"a=1"，也可能是一整条 "/plans?a=1"。
    const raw = String(search || "");
    const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw;
    if (!query) return null;
    try {
      return coerce(new URLSearchParams(query).get(queryKey));
    } catch {
      return null;
    }
  })();
  return fromQuery || coerce(storedValue) || defaultValue;
}

function tabParamOf(search: string, queryKey: string): string | null {
  const raw = String(search || "");
  const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw;
  if (!query) return null;
  try {
    return new URLSearchParams(query).get(queryKey);
  } catch {
    return null;
  }
}

/**
 * 页面已经打开时，地址栏的查询串变了（浏览器后退/前进、别处跳转），tab 要不要跟着换。
 *
 * 只看 tab 这个键有没有变：别的查询参数变了不动 tab。tab 键被去掉时 ——
 * 默认 tab 本来就不写进地址栏（clearDefaultFromUrl），所以「没有 tab」就是默认 tab，
 * 不能再回落到上次存的值，否则后退到默认 tab 那一条历史时页面纹丝不动。
 *
 * 返回 null 表示不用换。
 */
export function tabForSearchChange<T extends string>(
  previousSearch: string,
  nextSearch: string,
  values: readonly T[],
  defaultValue: T,
  options: { queryKey?: string; clearDefaultFromUrl?: boolean; storedValue?: string | null } = {},
): T | null {
  const queryKey = options.queryKey || "tab";
  const previous = tabParamOf(previousSearch, queryKey);
  const next = tabParamOf(nextSearch, queryKey);
  if (previous === next) return null;
  const clearDefaultFromUrl = options.clearDefaultFromUrl ?? true;
  return pickTabValue(nextSearch, clearDefaultFromUrl ? null : options.storedValue, values, defaultValue, queryKey);
}
