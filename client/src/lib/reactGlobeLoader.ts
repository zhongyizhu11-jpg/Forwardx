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
 * 用户「要去看地球了」的时候提前开始下载：手指 / 鼠标碰到地球视图按钮、或者
 * 键盘焦点落到它上面时调用。点下去之前通常还有一两百毫秒，够把包先拉起来。
 *
 * 原来是规则页、链路页一打开就在空闲时预取。实测这样得不偿失：
 * - 1.78 MB（gzip 500 KB 出头）每次进这两页都要下一遍，手机上规则页压根
 *   不给切地球视图（isMobile 时只有卡片），纯属白下；
 * - three-globe 模块一加载就会为读默认值建几个假图层，其中两个自带
 *   requestAnimationFrame 循环、从不销毁 —— 页面上没有地球，手机也一直在
 *   每秒 240 次地空转。看过一次地球再切走，还会多留一个没挂载上的地球实例
 *   接着转。两处都已打补丁（patches/three-globe@2.45.2.patch、
 *   patches/globe.gl@2.46.1.patch），现在进页面、预取、看完切走都是 0 个循环。
 *
 * 失败了把标志放回去，让下次还能再试 —— 不然一次网络抖动就等于这一整个
 * 会话都不再预取，用户点到地图那一下要干等。
 */
export function prefetchReactGlobe() {
  if (prefetchStarted || typeof window === "undefined") return;
  prefetchStarted = true;
  loadReactGlobe().catch(() => {
    prefetchStarted = false;
  });
}
