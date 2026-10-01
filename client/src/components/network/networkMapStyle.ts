import {
  NETWORK_MAP_BASE_LAYERS,
  NETWORK_MAP_BASE_LAYER_ORDER,
  type NetworkMapBaseLayerId,
  type NetworkMapSkin,
} from "@shared/networkMapBaseLayers";

/**
 * 网络地图的 MapLibre 样式：一份样式装下三种底图，切换时只改可见性和几个颜色。
 *
 * 不用 map.setStyle() 换整份样式 —— 那会把线路的 GeoJSON 源、feature-state 一起丢掉，
 * 切个底图线全闪一下。所以三种底图的栅格源一开始就都在样式里，哪个激活就哪个可见；
 * 没激活的源不会去拉瓦片（MapLibre 只给可见图层请求瓦片），不多花流量。
 *
 * 颜色全部由画布从 CSS 令牌（networkMap.css 里按皮肤定的 --nm-*）读出来传进来：MapLibre 不认 var()，
 * 而浅色 / 深色两套值只该有一个来源。
 *
 * 纯对象、不 import maplibre-gl，能在 node 里测。
 */

export const NETWORK_MAP_SOURCES = {
  countries: "nm-countries",
  links: "nm-links",
  flows: "nm-flows",
  /** 每一跳出口端的小箭头（三角形面） */
  tips: "nm-tips",
  /** 飞线上跑的彗星：头是点、尾是带 line-progress 的线，每帧 setData */
  comets: "nm-comets",
} as const;

export const NETWORK_MAP_LAYERS = {
  background: "nm-bg",
  /** 陆地往下错 1px 的一层淡影：纸面上微微浮起来，不用描粗边 */
  landShadow: "nm-land-shadow",
  land: "nm-land",
  borders: "nm-borders",
  flow: "nm-flow",
  /** 看不见的宽线：只给点击命中用（细线 2px 手指点不中） */
  linkHit: "nm-link-hit",
  /** 线底下一圈和底图同色系的细边：线压在国界、海岸线上也干净 */
  linkCasing: "nm-link-casing",
  linkDashed: "nm-link-dashed",
  linkSolid: "nm-link-solid",
  tip: "nm-tip",
  cometTail: "nm-comet-tail",
  cometGlow: "nm-comet-glow",
  cometHead: "nm-comet-head",
} as const;

/** 画线用的颜色：由页面从 CSS 变量里读出来再传进来（MapLibre 不认 var()） */
export type NetworkMapLineColors = {
  healthy: string;
  warn: string;
  down: string;
  standby: string;
  /** 线底下那圈细边（浅色皮肤是白，深色皮肤是近黑） */
  casing: string;
};

/** 自绘底图的颜色：水、陆地、陆地的影子、国界 */
export type NetworkMapBaseColors = {
  water: string;
  land: string;
  landShadow: string;
  border: string;
};

/** 线要素上的 health 属性只有这四档：模型的六档折到画法上就是这四种颜色 */
export type NetworkMapLineHealth = "healthy" | "warn" | "down" | "standby";

export function healthColorExpression(colors: NetworkMapLineColors) {
  return ["match", ["get", "health"], "healthy", colors.healthy, "warn", colors.warn, "down", colors.down, colors.standby];
}

/** 聚焦时无关的线降到 12%：feature-state 只改这一个数，不重发数据。 */
export function dimOpacityExpression(base: number) {
  return ["*", base, ["case", ["boolean", ["feature-state", "dim"], false], 0.12, 1]];
}

/** 栅格瓦片源的 id（和底图配置里 tiles[].id 一致） */
export function rasterSourceIds(): string[] {
  return NETWORK_MAP_BASE_LAYER_ORDER.flatMap((id) => NETWORK_MAP_BASE_LAYERS[id].tiles.map((tile) => tile.id));
}

/** 某个底图激活时，每个栅格图层该不该显示 */
export function rasterVisibility(active: NetworkMapBaseLayerId): Record<string, "visible" | "none"> {
  const out: Record<string, "visible" | "none"> = {};
  for (const id of NETWORK_MAP_BASE_LAYER_ORDER) {
    for (const tile of NETWORK_MAP_BASE_LAYERS[id].tiles) out[tile.id] = id === active ? "visible" : "none";
  }
  return out;
}

/**
 * 高德瓦片压一压：饱和度 −0.35、对比度略降，不然黄色的路、绿色的山比线和主机还抢眼；
 * 深色皮肤下标准图（白底）整体压暗到六成，像盖了一层暗色玻璃，深色卡片放上去不刺眼。
 */
export function rasterTonePaint(tileId: string, skin: NetworkMapSkin): Record<string, number> {
  const dimRoad = tileId === "amap-road" && skin === "dark";
  return {
    "raster-saturation": -0.35,
    "raster-contrast": dimRoad ? -0.18 : -0.08,
    "raster-brightness-min": 0,
    "raster-brightness-max": dimRoad ? 0.58 : tileId === "amap-road" ? 0.98 : 0.86,
  };
}

/** `#rrggbb` / `rgb()` 加一个透明度（MapLibre 的渐变要具体的颜色，认不了 color-mix） */
export function withAlpha(color: string, alpha: number): string {
  const rgb = parseRgb(color);
  return rgb ? `rgba(${rgb.join(",")},${alpha})` : color;
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

/** 往白色混一点：正常线路出口那头的浅色（认不出的写法原样返回） */
export function lighten(color: string, amount: number): string {
  const rgb = parseRgb(color);
  if (!rgb) return color;
  const mix = rgb.map((channel) => Math.round(channel + (255 - channel) * amount));
  return `#${mix.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * 正常线路沿线的两段渐变：入口是强调色，出口浅一档 —— 不靠动画也看得出这一跳从哪头出发。
 * 每一跳的坐标都是入口 → 出口（greatCircleArc(a, b)），line-progress 0 就是入口。源要开 lineMetrics。
 */
export function linkGradient(colors: NetworkMapLineColors) {
  return ["interpolate", ["linear"], ["line-progress"], 0, colors.healthy, 1, lighten(colors.healthy, 0.45)];
}

/** 彗星尾巴：从尾端透明渐到头部（line-progress 0 → 1），源要开 lineMetrics。比线本身淡，只是提示在流动 */
export function cometTailGradient(colors: NetworkMapLineColors) {
  return ["interpolate", ["linear"], ["line-progress"], 0, withAlpha(colors.healthy, 0), 0.65, withAlpha(colors.healthy, 0.35), 1, withAlpha(colors.healthy, 0.8)];
}

/** 彗星那三层要跟着皮肤换的颜色 */
export function cometPaint(colors: NetworkMapLineColors) {
  return {
    tail: { "line-gradient": cometTailGradient(colors) },
    glow: { "circle-color": colors.healthy },
    head: { "circle-color": colors.casing, "circle-stroke-color": colors.healthy },
  };
}

export function buildNetworkMapStyle(active: NetworkMapBaseLayerId, skin: NetworkMapSkin, countriesUrl: string, colors: NetworkMapLineColors, base: NetworkMapBaseColors) {
  const visibility = rasterVisibility(active);
  const patch = baseLayerPaintPatch(active, skin);
  const emptyCollection = { type: "FeatureCollection" as const, features: [] as never[] };
  const sources: Record<string, any> = {
    [NETWORK_MAP_SOURCES.countries]: { type: "geojson", data: countriesUrl },
    // promoteId：feature-state 要按 fid 找要素，不用 generateId 那种会随 setData 变的序号；
    // lineMetrics：正常线路的渐变按 line-progress 画
    [NETWORK_MAP_SOURCES.links]: { type: "geojson", data: emptyCollection, promoteId: "fid", lineMetrics: true },
    [NETWORK_MAP_SOURCES.flows]: { type: "geojson", data: emptyCollection, promoteId: "fid" },
    [NETWORK_MAP_SOURCES.tips]: { type: "geojson", data: emptyCollection, promoteId: "fid" },
    // lineMetrics：尾巴的渐变按 line-progress 画，要源算好每条线的长度
    [NETWORK_MAP_SOURCES.comets]: { type: "geojson", data: emptyCollection, lineMetrics: true },
  };
  const rasterLayers: any[] = [];
  for (const id of NETWORK_MAP_BASE_LAYER_ORDER) {
    for (const tile of NETWORK_MAP_BASE_LAYERS[id].tiles) {
      sources[tile.id] = { type: "raster", tiles: tile.urls, tileSize: tile.tileSize, maxzoom: tile.maxzoom };
      rasterLayers.push({
        id: tile.id,
        type: "raster",
        source: tile.id,
        layout: { visibility: visibility[tile.id] },
        // 切换时不淡入：底图一换点和线要同时换坐标（GCJ-02），淡入会让线先到、图后到
        paint: { "raster-fade-duration": 0, ...rasterTonePaint(tile.id, skin) },
      });
    }
  }
  const healthColor = healthColorExpression(colors);
  return {
    version: 8 as const,
    sources,
    layers: [
      { id: NETWORK_MAP_LAYERS.background, type: "background", paint: { "background-color": base.water } },
      ...rasterLayers,
      { id: NETWORK_MAP_LAYERS.landShadow, type: "fill", source: NETWORK_MAP_SOURCES.countries, paint: { "fill-color": base.landShadow, "fill-opacity": patch.landOpacity, "fill-translate": [0, 1.2], "fill-antialias": false } },
      { id: NETWORK_MAP_LAYERS.land, type: "fill", source: NETWORK_MAP_SOURCES.countries, paint: { "fill-color": base.land, "fill-opacity": patch.landOpacity } },
      { id: NETWORK_MAP_LAYERS.borders, type: "line", source: NETWORK_MAP_SOURCES.countries, layout: { "line-join": "round" }, paint: { "line-color": base.border, "line-width": patch.borderWidth } },
      // 落地流向：细虚线，比隧道淡
      { id: NETWORK_MAP_LAYERS.flow, type: "line", source: NETWORK_MAP_SOURCES.flows, paint: { "line-color": healthColor, "line-width": 1.1, "line-opacity": dimOpacityExpression(0.55), "line-dasharray": [1.5, 2.5] } },
      { id: NETWORK_MAP_LAYERS.linkHit, type: "line", source: NETWORK_MAP_SOURCES.links, paint: { "line-color": healthColor, "line-width": 14, "line-opacity": 0 } },
      { id: NETWORK_MAP_LAYERS.linkCasing, type: "line", source: NETWORK_MAP_SOURCES.links, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": colors.casing, "line-width": 4.5, "line-blur": 1, "line-opacity": dimOpacityExpression(0.7) } },
      // 不正常的：警告 / 中断色的虚线，不跑彗星
      { id: NETWORK_MAP_LAYERS.linkDashed, type: "line", source: NETWORK_MAP_SOURCES.links, filter: ["!=", ["get", "health"], "healthy"], layout: { "line-join": "round" }, paint: { "line-color": healthColor, "line-width": 1.8, "line-opacity": dimOpacityExpression(1), "line-dasharray": [4, 2.5] } },
      // 正常的：入口强调色 → 出口浅一档的渐变实线
      { id: NETWORK_MAP_LAYERS.linkSolid, type: "line", source: NETWORK_MAP_SOURCES.links, filter: ["==", ["get", "health"], "healthy"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-gradient": linkGradient(colors), "line-width": 2, "line-opacity": dimOpacityExpression(1) } },
      // 出口端的箭头：不靠动画也看得出这一跳往哪儿去
      { id: NETWORK_MAP_LAYERS.tip, type: "fill", source: NETWORK_MAP_SOURCES.tips, paint: { "fill-color": healthColor, "fill-opacity": dimOpacityExpression(1), "fill-antialias": true } },
      // 彗星：渐隐的尾巴、一点淡光、一颗小亮头 —— 比线淡，只说「在流动」
      { id: NETWORK_MAP_LAYERS.cometTail, type: "line", source: NETWORK_MAP_SOURCES.comets, filter: ["==", ["geometry-type"], "LineString"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-width": 2, "line-gradient": cometTailGradient(colors) } },
      { id: NETWORK_MAP_LAYERS.cometGlow, type: "circle", source: NETWORK_MAP_SOURCES.comets, filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 5, "circle-color": colors.healthy, "circle-opacity": 0.22, "circle-blur": 0.9 } },
      { id: NETWORK_MAP_LAYERS.cometHead, type: "circle", source: NETWORK_MAP_SOURCES.comets, filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 2.2, "circle-color": colors.casing, "circle-opacity": 0.9, "circle-stroke-width": 1.4, "circle-stroke-color": colors.healthy, "circle-stroke-opacity": 0.9 } },
    ],
  };
}

/** 换底图 / 换皮肤时要改的那几项（不重建样式）：自绘陆地和国界显不显示、栅格可见性和压色 */
export function baseLayerPaintPatch(active: NetworkMapBaseLayerId, skin: NetworkMapSkin) {
  const base = NETWORK_MAP_BASE_LAYERS[active];
  const raster = rasterVisibility(active);
  return {
    landOpacity: base.vector ? 1 : 0,
    borderWidth: base.vector ? 0.5 : 0,
    raster,
    rasterPaint: Object.fromEntries(Object.keys(raster).map((id) => [id, rasterTonePaint(id, skin)])),
  };
}
