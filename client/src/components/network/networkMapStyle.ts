import {
  NETWORK_MAP_BASE_LAYERS,
  NETWORK_MAP_BASE_LAYER_ORDER,
  graticuleGeoJson,
  type NetworkMapBaseLayerId,
} from "@shared/networkMapBaseLayers";

/**
 * 网络地图的 MapLibre 样式：一份样式装下三种底图，切换时只改可见性和几个颜色。
 *
 * 不用 map.setStyle() 换整份样式 —— 那会把线路的 GeoJSON 源、feature-state 一起丢掉，
 * 切个底图线全闪一下。所以三种底图的栅格源一开始就都在样式里，哪个激活就哪个可见；
 * 没激活的源不会去拉瓦片（MapLibre 只给可见图层请求瓦片），不多花流量。
 *
 * 纯对象、不 import maplibre-gl，能在 node 里测。
 */

export const NETWORK_MAP_SOURCES = {
  countries: "nm-countries",
  graticule: "nm-graticule",
  links: "nm-links",
  flows: "nm-flows",
  /** 每一跳出口端的小箭头（三角形面） */
  tips: "nm-tips",
  /** 飞线上跑的彗星：头是点、尾是带 line-progress 的线，每帧 setData */
  comets: "nm-comets",
} as const;

export const NETWORK_MAP_LAYERS = {
  background: "nm-bg",
  land: "nm-land",
  graticule: "nm-graticule",
  borders: "nm-borders",
  flow: "nm-flow",
  linkHalo: "nm-link-halo",
  linkDashed: "nm-link-dashed",
  linkSolid: "nm-link-solid",
  linkFlow: "nm-link-flow",
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
 * 正常线路上流动的光点：只改 dasharray，交给 GPU。
 * 一圈 14 步，每步 70ms 一帧，看上去是一段亮线沿着弧往前跑。
 */
export const NETWORK_MAP_DASH_STEPS: number[][] = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
  [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
];

export const NETWORK_MAP_DASH_INTERVAL_MS = 70;

/** `#rrggbb` / `rgb()` 加一个透明度（MapLibre 的渐变要具体的颜色，认不了 color-mix） */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3);
    if (parts.length === 3) return `rgba(${parts.join(",")},${alpha})`;
  }
  return color;
}

/** 彗星尾巴：从尾端透明渐到头部实色（line-progress 0 → 1），源要开 lineMetrics */
export function cometTailGradient(colors: NetworkMapLineColors) {
  return ["interpolate", ["linear"], ["line-progress"], 0, withAlpha(colors.healthy, 0), 0.6, withAlpha(colors.healthy, 0.55), 1, colors.healthy];
}

/** 彗星那三层要跟着皮肤换的颜色 */
export function cometPaint(colors: NetworkMapLineColors) {
  return {
    tail: { "line-gradient": cometTailGradient(colors) },
    glow: { "circle-color": colors.healthy },
    head: { "circle-stroke-color": colors.healthy },
  };
}

export function buildNetworkMapStyle(active: NetworkMapBaseLayerId, countriesUrl: string, colors: NetworkMapLineColors) {
  const base = NETWORK_MAP_BASE_LAYERS[active];
  const visibility = rasterVisibility(active);
  const emptyCollection = { type: "FeatureCollection" as const, features: [] as never[] };
  const sources: Record<string, any> = {
    [NETWORK_MAP_SOURCES.countries]: { type: "geojson", data: countriesUrl },
    [NETWORK_MAP_SOURCES.graticule]: { type: "geojson", data: graticuleGeoJson() },
    // promoteId：feature-state 要按 fid 找要素，不用 generateId 那种会随 setData 变的序号
    [NETWORK_MAP_SOURCES.links]: { type: "geojson", data: emptyCollection, promoteId: "fid" },
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
        paint: { "raster-fade-duration": 0 },
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
      { id: NETWORK_MAP_LAYERS.land, type: "fill", source: NETWORK_MAP_SOURCES.countries, paint: { "fill-color": base.land, "fill-opacity": base.landOpacity } },
      {
        id: NETWORK_MAP_LAYERS.graticule,
        type: "line",
        source: NETWORK_MAP_SOURCES.graticule,
        layout: { visibility: base.graticule ? "visible" : "none" },
        paint: { "line-color": "rgba(6,182,212,0.13)", "line-width": 0.6 },
      },
      { id: NETWORK_MAP_LAYERS.borders, type: "line", source: NETWORK_MAP_SOURCES.countries, paint: { "line-color": base.border, "line-width": base.borderWidth } },
      // 落地流向：细虚线，比隧道淡
      { id: NETWORK_MAP_LAYERS.flow, type: "line", source: NETWORK_MAP_SOURCES.flows, paint: { "line-color": healthColor, "line-width": 1.3, "line-opacity": dimOpacityExpression(0.55), "line-dasharray": [1.5, 2.5] } },
      { id: NETWORK_MAP_LAYERS.linkHalo, type: "line", source: NETWORK_MAP_SOURCES.links, paint: { "line-color": healthColor, "line-width": 10, "line-blur": 5, "line-opacity": dimOpacityExpression(0.16) } },
      { id: NETWORK_MAP_LAYERS.linkDashed, type: "line", source: NETWORK_MAP_SOURCES.links, filter: ["!=", ["get", "health"], "healthy"], paint: { "line-color": healthColor, "line-width": 2.4, "line-opacity": dimOpacityExpression(1), "line-dasharray": [2.4, 2] } },
      { id: NETWORK_MAP_LAYERS.linkSolid, type: "line", source: NETWORK_MAP_SOURCES.links, filter: ["==", ["get", "health"], "healthy"], paint: { "line-color": healthColor, "line-width": 2.4, "line-opacity": dimOpacityExpression(1) } },
      { id: NETWORK_MAP_LAYERS.linkFlow, type: "line", source: NETWORK_MAP_SOURCES.links, filter: ["==", ["get", "health"], "healthy"], paint: { "line-color": "#ffffff", "line-width": 2.2, "line-opacity": dimOpacityExpression(0.85), "line-dasharray": NETWORK_MAP_DASH_STEPS[0] } },
      // 出口端的箭头：不靠动画也看得出这一跳往哪儿去
      { id: NETWORK_MAP_LAYERS.tip, type: "fill", source: NETWORK_MAP_SOURCES.tips, paint: { "fill-color": healthColor, "fill-opacity": dimOpacityExpression(0.95), "fill-antialias": true } },
      // 彗星：渐隐的尾巴、一圈柔光、白色的亮头
      { id: NETWORK_MAP_LAYERS.cometTail, type: "line", source: NETWORK_MAP_SOURCES.comets, filter: ["==", ["geometry-type"], "LineString"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-width": 3, "line-gradient": cometTailGradient(colors) } },
      { id: NETWORK_MAP_LAYERS.cometGlow, type: "circle", source: NETWORK_MAP_SOURCES.comets, filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 8, "circle-color": colors.healthy, "circle-opacity": 0.4, "circle-blur": 0.9 } },
      { id: NETWORK_MAP_LAYERS.cometHead, type: "circle", source: NETWORK_MAP_SOURCES.comets, filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 3, "circle-color": "#ffffff", "circle-stroke-width": 1.5, "circle-stroke-color": colors.healthy } },
    ],
  };
}

/** 换底图时要改的那几项（不重建样式）：背景、陆地、国界、网格、栅格可见性 */
export function baseLayerPaintPatch(active: NetworkMapBaseLayerId) {
  const base = NETWORK_MAP_BASE_LAYERS[active];
  return {
    background: base.water,
    land: base.land,
    landOpacity: base.landOpacity,
    border: base.border,
    borderWidth: base.borderWidth,
    graticule: base.graticule ? ("visible" as const) : ("none" as const),
    raster: rasterVisibility(active),
  };
}
