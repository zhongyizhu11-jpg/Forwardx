/*
  按路由拆出去的页面包，一处登记。

  App.tsx 里的 lazy() 和这里用的是同一个 import() 表达式，所以 Vite 打出来是同一个
  chunk —— 这张表的用处是**提前取**：标签栏和侧栏在空闲时把最常去的几页先拉下来，
  手指点过去时代码已经在缓存里，不用再看一次「正在加载页面」。

  为什么不直接在 App.tsx 里 export 那些 lazy 组件：lazy 组件只在渲染时才触发 import，
  预取要的是「现在就下」，得拿到原始的 import 函数。
*/
export const routeChunks: Record<string, () => Promise<unknown>> = {
  "/hosts": () => import("@/pages/Hosts"),
  "/rules": () => import("@/pages/Rules"),
  "/tunnels": () => import("@/pages/Tunnels"),
  "/more": () => import("@/pages/More"),
  "/client-subscriptions": () => import("@/pages/ClientSubscriptions"),
  "/profile": () => import("@/pages/Profile"),
  "/settings": () => import("@/pages/Settings"),
  "/announcements": () => import("@/pages/Announcements"),
  "/subscriptions": () => import("@/pages/Subscriptions"),
  "/looking-glass": () => import("@/pages/LookingGlass"),
  "/users": () => import("@/pages/Users"),
  "/plans": () => import("@/pages/Plans"),
  "/billing": () => import("@/pages/Billing"),
  "/payments": () => import("@/pages/Payments"),
  "/wallet": () => import("@/pages/Wallet"),
  "/store": () => import("@/pages/Store"),
  "/forward-groups": () => import("@/pages/ForwardGroupsRoute"),
  "/proxy-inbounds": () => import("@/pages/ProxyInbounds"),
  "/traffic-billing": () => import("@/pages/TrafficBilling"),
  "/plugins": () => import("@/pages/Plugins"),
};

const prefetched = new Set<string>();

/** 把某一页的代码先拉下来。重复调用没有代价：浏览器的模块缓存只下一次。 */
export function prefetchRoute(path: string): Promise<unknown> | undefined {
  const loader = routeChunks[path];
  if (!loader) return undefined;
  if (prefetched.has(path)) return Promise.resolve();
  prefetched.add(path);
  return loader().catch(() => {
    // 网络抖一下没取到：下次点击时 lazy() 会自己再试，这里不用记错。
    prefetched.delete(path);
  });
}

/**
 * 空闲时把一批页面拉下来。用 requestIdleCallback：首屏的数据请求和渲染先走，
 * 页面包排在它们后面 —— 预取是为了让第二屏快，不能让第一屏慢。
 */
export function prefetchRoutesWhenIdle(paths: string[]) {
  if (typeof window === "undefined") return () => undefined;
  const run = () => { for (const path of paths) void prefetchRoute(path); };
  const idle = (window as any).requestIdleCallback as undefined | ((cb: () => void, opts?: { timeout: number }) => number);
  if (idle) {
    const handle = idle(run, { timeout: 4000 });
    return () => (window as any).cancelIdleCallback?.(handle);
  }
  const timer = window.setTimeout(run, 1500);
  return () => window.clearTimeout(timer);
}

/**
 * 点击前先等一小会儿让代码到位，再换页。
 *
 * 换页时的转圈来自 Suspense：路由一变，新页面的代码还没到，就先画 fallback。这里把
 * 顺序倒过来 —— 先取代码，最多等 `maxWaitMs`，到了就换页（代码已缓存时是同步的），
 * 没到也换页（还是原来的 fallback 兜底）。用户看到的是「点了就切过去」，而不是
 * 「点了 → 转圈 → 出来」。
 */
export function navigateAfterPrefetch(path: string, navigate: () => void, maxWaitMs = 250) {
  const pending = prefetchRoute(path);
  if (!pending) { navigate(); return; }
  let done = false;
  const go = () => { if (done) return; done = true; navigate(); };
  const timer = window.setTimeout(go, maxWaitMs);
  void pending.then(() => { window.clearTimeout(timer); go(); });
}
