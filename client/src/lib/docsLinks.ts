/**
 * 使用文档的地址，全站一份。
 *
 * 原来设置页、侧边栏、公开首页各写了一遍完整网址。文档站哪天换地方，漏改一处，
 * 那一处的「怎么用？」就指向一个打不开的页面 —— 而那正是用户卡住、需要帮助的时候。
 */
export const DOCS_BASE_URL = "https://zhongyizhu11-jpg.github.io/Forwardx";

/** `docsUrl("/guide/failover")` → 文档站上那一页。 */
export function docsUrl(path = "/"): string {
  return `${DOCS_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
