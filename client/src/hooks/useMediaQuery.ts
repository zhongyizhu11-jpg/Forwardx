import { useEffect, useState } from "react";

/**
 * 一条媒体查询现在是否成立（`(min-width: 900px)`、`(prefers-reduced-motion: reduce)`）。
 *
 * 网络地图整页和首页那块小图都要看「宽不宽、要不要少动」，原来写在页面文件里，
 * 这里抽成一份。没有 window（node 里 renderToStaticMarkup）时一律不成立。
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
