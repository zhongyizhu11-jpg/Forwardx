/**
 * react-globe.gl 的加载与预取，全站一份。
 *
 * 链路管理和转发规则两页原来各有一份 loadReactGlobe + 一个模块级的
 * reactGlobePrefetchStarted 标志。两份标志互不知道对方 —— 先后打开这两页，
 * 预取就会发两次。这个包 gzip 后 500 KB 出头，在手机上白下一遍不是小事。
 */
export const loadReactGlobe = () => import("react-globe.gl");

let prefetchStarted = false;

/**
 * 空闲时预取地球组件。
 *
 * 失败了把标志放回去，让下次进页面还能再试 —— 不然一次网络抖动就等于这一
 * 整个会话都不再预取，用户点到地图那一下要干等。
 */
export function prefetchReactGlobe() {
  if (prefetchStarted || typeof window === "undefined") return;
  prefetchStarted = true;
  const startPrefetch = () => {
    loadReactGlobe().catch(() => {
      prefetchStarted = false;
    });
  };
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(startPrefetch, { timeout: 2200 });
  } else {
    globalThis.setTimeout(startPrefetch, 700);
  }
}
