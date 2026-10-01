import { useEffect, useState } from "react";

/**
 * 一条媒体查询现在是否成立（`(min-width: 900px)`、`(prefers-reduced-motion: reduce)`）。
 *
 * 首页的网络地图要看「要不要少动」，抽成一份共用的。没有 window（node 里
 * renderToStaticMarkup）时一律不成立。
 */
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => (typeof window !== "undefined" ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
