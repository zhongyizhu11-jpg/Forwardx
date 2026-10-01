import { NETWORK_MAP_NIGHT_TILE_URL, NETWORK_MAP_TEXTURE_MAX_ZOOM } from "@shared/networkMapTexture";

/**
 * 首页网络地图的 MapLibre 样式：一张固定的夜景底图，上面是线、出口箭头、中转点和流动的光点。
 *
 * 底图：夜光地球图（components/network/earthTiles.ts 注册的协议现拉伸成墨卡托）。地球图只有 2048 像素宽，
 * 放大到 5.5 级以上就是一块糊掉的色块，所以 4.5 → 5.5 级淡出，换成 Natural Earth 国界自绘的深色陆地；
 * 再放大到 7 级，110m 的粗海岸线也淡下去（它和真实海岸线对不上），只剩一层均匀的深色。没有底图切换。
 *
 * 线是「霓虹」画法：每条线两层 —— 底下一道宽而模糊、半透明的光，上面一道细而亮的芯。四类线
 * （networkMapLines：主线路 / 备用 / 降级 / 中断）各一种颜色，主线路实线、其余虚线；出口那头一个
 * 同色的小三角（画布按屏幕像素算好交过来），光点停下来（减少动态）时也看得出往哪边走。
 *
 * 颜色全部由画布从 CSS 令牌（networkMap.css 里 .nm-surface 的 --nm-*）读出来传进来：MapLibre 不认 var()。
 *
 * 纯对象、不 import maplibre-gl，能在 node 里测。
 */

export const NETWORK_MAP_SOURCES = {
  countries: "nm-countries",
  night: "earth-night",
  links: "nm-links",
  /** 出口端的箭头：屏幕像素里算好的三角形，每次布局重写 */
  arrows: "nm-arrows",
  /** 备用线路经过的中转点：灰色小点 */
  waypoints: "nm-waypoints",
  /** 主线路上流动的光点，动画时按帧 setData（最多 30 帧） */
  particles: "nm-particles",
} as const;

export const NETWORK_MAP_LAYERS = {
  background: "nm-bg",
  night: "earth-night",
  land: "nm-land",
  borders: "nm-borders",
  /** 看不见的宽线：只给点击命中用（细线手指点不中） */
  linkHit: "nm-link-hit",
  /** 霓虹的光：宽、模糊、半透明 */
  linkGlow: "nm-link-glow",
  /** 主线路：实线的芯（入口 → 出口一点点渐亮） */
  linkMain: "nm-link-main",
  /** 备用 / 降级 / 中断：虚线的芯 */
  linkDashed: "nm-link-dashed",
  arrows: "nm-arrows",
  waypoints: "nm-waypoints",
  particleGlow: "nm-particle-glow",
  particleCore: "nm-particle-core",
} as const;

/** 四类线和光点的颜色：由画布从 CSS 变量里读出来再传进来 */
export type NetworkMapLineColors = {
  main: string;
  backup: string;
  degraded: string;
  down: string;
  /** 光点的芯（近白） */
  particle: string;
};

/**
 * 底图的颜色：水（底色）、地球图淡出后接上来的陆地、国界。取的是夜光图（调过色）里海和没灯的陆地的
 * 样子 —— 近黑的海军蓝，陆地只亮一点点 —— 放大缩小时不会突然换一种蓝。
 */
export type NetworkMapBaseColors = {
  water: string;
  land: string;
  border: string;
};

export function kindColorExpression(colors: NetworkMapLineColors) {
  return ["match", ["get", "kind"], "main", colors.main, "degraded", colors.degraded, "down", colors.down, colors.backup];
}

/** 光的透明度：主线路亮一些，虚线的光淡一些（不然虚线的缝被光填满，看着像实线） */
export function glowOpacity() {
  return ["match", ["get", "kind"], "main", 0.5, "down", 0.3, "degraded", 0.28, 0.16];
}

/**
 * 地球图在这两级之间淡出、矢量的陆地和国界淡入；到 TEXTURE_LAYER_MAX_ZOOM 地球图图层就不画了（图层的
 * maxzoom：MapLibre 连瓦片都不再要）。地球图只有 2048 像素宽，3 级就是原图的分辨率，再往上全是拉大的同一块像素。
 */
export const TEXTURE_FADE_ZOOM: readonly [number, number] = [4.5, 5.5];
export const TEXTURE_LAYER_MAX_ZOOM = TEXTURE_FADE_ZOOM[1];

export function zoomFade(from: number, to: number) {
  return ["interpolate", ["linear"], ["zoom"], TEXTURE_FADE_ZOOM[0], from, TEXTURE_FADE_ZOOM[1], to];
}

/**
 * 陆地和国界用的是 Natural Earth 1:110m 的国界，6 级以上就和真实海岸线对不上了 —— 珠江口在它里面是一个
 * 几十公里的三角形缺口，点开港粤那一组时正好在画面里，看着像一块深色的三角形接缝。所以 5.5 → 7 级之间
 * 把陆地和国界淡到很淡：放大以后底图只剩一层均匀的深色，粗糙的海岸线不再画出一个假的形状。
 */
export const COARSE_COAST_ZOOM: readonly [number, number] = [5.5, 7];
const COARSE_COAST_FLOOR = 0.15;

/**
 * 陆地 / 国界的透明度：远看是 overTexture（夜光图上陆地不画、国界淡淡一道），地球图淡出时接满，
 * 再放大到粗海岸线对不上的那一段又淡下去。
 */
function vectorOpacity(overTexture: number): unknown[] {
  // MapLibre 要求插值的级别严格递增：地球图淡没的那一级和粗海岸线开始淡的那一级重合，只写一次
  return ["interpolate", ["linear"], ["zoom"], TEXTURE_FADE_ZOOM[0], overTexture, TEXTURE_FADE_ZOOM[1], 1, COARSE_COAST_ZOOM[1], COARSE_COAST_FLOOR];
}
export const LAND_OPACITY = vectorOpacity(0);
export const BORDER_OPACITY = vectorOpacity(0.5);

/**
 * 夜光图的压色：提对比和饱和度，城市灯光更橙更亮；透明度 0.9 —— 黑色的海透出底下的深海军蓝；灯光提亮、
 * 海压暗是瓦片拉伸时就调好的（gradeNightPixels）。4.5 → 5.5 级淡到 0（zoomFade），之后只剩矢量底图。
 */
export function nightTonePaint(): Record<string, unknown> {
  return { "raster-opacity": zoomFade(0.9, 0), "raster-contrast": 0.08, "raster-saturation": 0.1, "raster-brightness-min": 0, "raster-brightness-max": 1 };
}

function parseRgb(color: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
    if (parts.length === 3 && parts.every((part) => Number.isFinite(part))) return [parts[0], parts[1], parts[2]];
  }
  return null;
}

/** 往白色混一点（认不出的写法原样返回） */
export function lighten(color: string, amount: number): string {
  const rgb = parseRgb(color);
  if (!rgb) return color;
  const mix = rgb.map((channel) => Math.round(channel + (255 - channel) * amount));
  return `#${mix.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * 主线路沿线一点点渐亮：入口是亮蓝，出口再亮一档 —— 和出口的箭头一起说方向。
 * 每一跳的坐标都是入口 → 出口（greatCircleArc(a, b)），line-progress 0 就是入口。源要开 lineMetrics。
 */
export function linkGradient(colors: NetworkMapLineColors) {
  return ["interpolate", ["linear"], ["line-progress"], 0, colors.main, 1, lighten(colors.main, 0.4)];
}

export function buildNetworkMapStyle(countriesUrl: string, colors: NetworkMapLineColors, base: NetworkMapBaseColors) {
  const emptyCollection = { type: "FeatureCollection" as const, features: [] as never[] };
  const kindColor = kindColorExpression(colors);
  return {
    version: 8 as const,
    sources: {
      [NETWORK_MAP_SOURCES.countries]: { type: "geojson", data: countriesUrl },
      // 夜光图按瓦片现拉伸，最多切到第 4 级，再往上 MapLibre 自己放大
      [NETWORK_MAP_SOURCES.night]: { type: "raster", tiles: [NETWORK_MAP_NIGHT_TILE_URL], tileSize: 256, maxzoom: NETWORK_MAP_TEXTURE_MAX_ZOOM },
      // lineMetrics：主线路的渐变按 line-progress 画
      [NETWORK_MAP_SOURCES.links]: { type: "geojson", data: emptyCollection, lineMetrics: true },
      [NETWORK_MAP_SOURCES.arrows]: { type: "geojson", data: emptyCollection },
      [NETWORK_MAP_SOURCES.waypoints]: { type: "geojson", data: emptyCollection },
      [NETWORK_MAP_SOURCES.particles]: { type: "geojson", data: emptyCollection },
    } as Record<string, any>,
    layers: [
      { id: NETWORK_MAP_LAYERS.background, type: "background", paint: { "background-color": base.water } },
      // maxzoom：5.5 级以上地球图已经淡没了，图层直接不画、也不再要瓦片（不留一层糊掉的像素）
      { id: NETWORK_MAP_LAYERS.night, type: "raster", source: NETWORK_MAP_SOURCES.night, maxzoom: TEXTURE_LAYER_MAX_ZOOM, paint: { "raster-fade-duration": 0, ...nightTonePaint() } },
      { id: NETWORK_MAP_LAYERS.land, type: "fill", source: NETWORK_MAP_SOURCES.countries, paint: { "fill-color": base.land, "fill-opacity": LAND_OPACITY } },
      { id: NETWORK_MAP_LAYERS.borders, type: "line", source: NETWORK_MAP_SOURCES.countries, layout: { "line-join": "round" }, paint: { "line-color": base.border, "line-width": 0.5, "line-opacity": BORDER_OPACITY } },
      { id: NETWORK_MAP_LAYERS.linkHit, type: "line", source: NETWORK_MAP_SOURCES.links, paint: { "line-color": kindColor, "line-width": 14, "line-opacity": 0 } },
      { id: NETWORK_MAP_LAYERS.linkGlow, type: "line", source: NETWORK_MAP_SOURCES.links, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": kindColor, "line-width": ["match", ["get", "kind"], "main", 9, 7], "line-blur": 6, "line-opacity": glowOpacity() } },
      { id: NETWORK_MAP_LAYERS.linkMain, type: "line", source: NETWORK_MAP_SOURCES.links, filter: ["==", ["get", "kind"], "main"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-gradient": linkGradient(colors), "line-width": 2 } },
      // 虚线压在主线路上面：出问题的线、备用线和主线路走同一段时不能被盖住
      { id: NETWORK_MAP_LAYERS.linkDashed, type: "line", source: NETWORK_MAP_SOURCES.links, filter: ["!=", ["get", "kind"], "main"], layout: { "line-join": "round" }, paint: { "line-color": kindColor, "line-width": 1.6, "line-opacity": ["match", ["get", "kind"], "backup", 0.75, 1], "line-dasharray": [3, 2.5] } },
      // 出口的箭头：和线同色；主线路的箭头取渐变的尾色（出口那头更亮的那一档）
      { id: NETWORK_MAP_LAYERS.arrows, type: "fill", source: NETWORK_MAP_SOURCES.arrows, paint: { "fill-color": ["match", ["get", "kind"], "main", lighten(colors.main, 0.4), "degraded", colors.degraded, "down", colors.down, colors.backup], "fill-opacity": ["match", ["get", "kind"], "backup", 0.75, 1], "fill-antialias": true } },
      { id: NETWORK_MAP_LAYERS.waypoints, type: "circle", source: NETWORK_MAP_SOURCES.waypoints, paint: { "circle-radius": 2.6, "circle-color": colors.backup, "circle-opacity": 0.85, "circle-stroke-width": 1, "circle-stroke-color": base.water, "circle-stroke-opacity": 0.9 } },
      // 光点：一圈淡淡的光 + 一颗近白的芯
      { id: NETWORK_MAP_LAYERS.particleGlow, type: "circle", source: NETWORK_MAP_SOURCES.particles, paint: { "circle-radius": 6, "circle-color": colors.main, "circle-opacity": 0.45, "circle-blur": 1 } },
      { id: NETWORK_MAP_LAYERS.particleCore, type: "circle", source: NETWORK_MAP_SOURCES.particles, paint: { "circle-radius": 1.8, "circle-color": colors.particle, "circle-opacity": 0.95 } },
    ],
  };
}
