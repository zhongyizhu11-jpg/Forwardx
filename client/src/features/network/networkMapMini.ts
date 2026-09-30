import type { NetworkMapModel } from "./networkMapModel";

/**
 * 首页那块「网络地图」小图的规则：什么时候画真地图、框哪些点、点了往哪儿跳。
 *
 * 纯函数（detectWebGL 除外），画布和卡片各自只管照着做；在 node 里能测。
 */

/** 小图框住所有主机时最多放大到这一级：两台同城的机器不该缩成一张街道图 */
export const MINI_FIT_MAX_ZOOM = 9;
/** 小图上一跳的两端在屏幕上至少隔这么远才挂延迟胶囊（整页是 110） */
export const MINI_CAP_MIN_ARC_PX = 90;

export function locatedHostCount(model: Pick<NetworkMapModel, "nodes">): number {
  return model.nodes.filter((node) => !!node.geo).length;
}

export function unlocatedHostCount(model: Pick<NetworkMapModel, "nodes">): number {
  return model.nodes.length - locatedHostCount(model);
}

/** 要框住的点：主机；开了落地流向再加上定位到的目标 */
export function miniFitPoints(model: Pick<NetworkMapModel, "nodes" | "targets">, showFlows: boolean): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (const node of model.nodes) if (node.geo) points.push([node.geo.lng, node.geo.lat]);
  if (showFlows) for (const target of model.targets) if (target.geo) points.push([target.geo.lng, target.geo.lat]);
  return points;
}

/**
 * 画真地图还是留着原来的 SVG 示意图：没有 WebGL（远程桌面、老浏览器）或者一台主机都
 * 没定位时，真地图上什么都摆不出来，示意图反而能把「谁连着谁」说清楚。
 */
export function shouldRenderRealMap(input: { webgl: boolean; locatedHosts: number }): boolean {
  return input.webgl && input.locatedHosts > 0;
}

/** 小图上点了主机 / 线路要跳去的整页地址（整页一打开就弹那个详情） */
export function miniOpenHref(target: { kind: "host" | "link"; id: number } | null): string {
  if (!target) return "/map";
  return target.kind === "host" ? `/map?host=${target.id}` : `/map?link=${target.id}`;
}

let webglSupported: boolean | null = null;

/**
 * 这个浏览器建不建得出 WebGL 上下文。只测一次：建上下文不便宜，而且答案不会变。
 * 没有 document（node）当不支持。
 */
export function detectWebGL(): boolean {
  if (webglSupported !== null) return webglSupported;
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    webglSupported = !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    webglSupported = false;
  }
  return webglSupported;
}
