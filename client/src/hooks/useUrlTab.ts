import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { pickTabValue } from "@/lib/urlTab";

type UseUrlTabOptions<T extends string> = {
  values: readonly T[];
  defaultValue: T;
  storageKey?: string;
  queryKey?: string;
  clearDefaultFromUrl?: boolean;
};

/**
 * 地址栏里的查询串。
 *
 * **不能**从 wouter 的 `useLocation()` 里取：它只给路径，不含 `?` 后面的部分，
 * 于是 `location.split("?")[1]` 永远是空 —— `?tab=xxx` 深链接一直是个死功能，
 * 而且不报错，只是默默回落到默认 tab。
 */
function currentSearch() {
  if (typeof window === "undefined") return "";
  return window.location.search || "";
}

function readStoredTab<T extends string>(storageKey: string | undefined, coerce: (value: unknown) => T | null) {
  if (!storageKey || typeof window === "undefined") return null;
  try {
    return coerce(window.localStorage.getItem(storageKey));
  } catch {
    return null;
  }
}

function writeStoredTab(storageKey: string | undefined, value: string) {
  if (!storageKey || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, value);
  } catch {
    // URL state still works when localStorage is unavailable.
  }
}

export function useUrlTab<T extends string>({
  values,
  defaultValue,
  storageKey,
  queryKey = "tab",
  clearDefaultFromUrl = true,
}: UseUrlTabOptions<T>) {
  const [location, setLocation] = useLocation();
  const valuesKey = values.join("\0");
  const allowedValues = useMemo(() => new Set<T>(values), [valuesKey]);

  const coerce = useCallback((value: unknown): T | null => {
    const raw = String(value || "");
    return allowedValues.has(raw as T) ? (raw as T) : null;
  }, [allowedValues]);

  const resolveTab = useCallback(() => {
    return pickTabValue(currentSearch(), readStoredTab(storageKey, coerce), values, defaultValue, queryKey);
  }, [coerce, defaultValue, location, queryKey, storageKey, valuesKey]);

  const [tab, setTabState] = useState<T>(() => resolveTab());

  useEffect(() => {
    const next = resolveTab();
    setTabState((current) => (current === next ? current : next));
    writeStoredTab(storageKey, next);
  }, [resolveTab, storageKey]);

  const setTab = useCallback((nextValue: T | string) => {
    const next = coerce(nextValue) || defaultValue;
    setTabState(next);
    writeStoredTab(storageKey, next);

    // 路径从 wouter 拿（它给的就是路径），查询串从地址栏拿。
    const path = location.split("?")[0];
    const params = new URLSearchParams(currentSearch());
    if (clearDefaultFromUrl && next === defaultValue) {
      params.delete(queryKey);
    } else {
      params.set(queryKey, next);
    }
    const nextQuery = params.toString();
    const nextLocation = `${path || "/"}${nextQuery ? `?${nextQuery}` : ""}`;
    if (nextLocation !== `${path}${currentSearch()}`) setLocation(nextLocation);
  }, [clearDefaultFromUrl, coerce, defaultValue, location, queryKey, setLocation, storageKey]);

  return [tab, setTab] as const;
}
