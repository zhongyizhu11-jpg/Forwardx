import {
  NETWORK_MAP_ALL_BASE_LAYERS,
  NETWORK_MAP_BASE_LAYERS,
  NETWORK_MAP_TEXTURE_MAX_ZOOM,
  textureTileUrl,
  type NetworkMapBaseLayerId,
  type NetworkMapTextureId,
} from "@shared/networkMapBaseLayers";

/**
 * 网络地图的 MapLibre 样式：一份样式装下四种底图，切换时只改可见性。
 *
 * 不用 map.setStyle() 换整份样式 —— 那会把线路的 GeoJSON 源、feature-state 一起丢掉，
 * 切个底图线全闪一下。所以几种底图的栅格源一开始就都在样式里，哪个激活就哪个可见；
 * 没激活的源不会去拉瓦片（MapLibre 只给可见图层请求瓦片），地球图也不会下载。
 *
 * 线是「霓虹」画法：每条线两层 —— 底下一道宽而模糊、半透明的光，上面一道细而亮的芯。四类线
 * （networkMapLines：主线路 / 备用 / 降级 / 中断）各一种颜色，主线路实线、其余虚线。
 *
 * 颜色全部由画布从 CSS 令牌（networkMap.css 里 .nm-surface 的 --nm-*）读出来传进来：MapLibre 不认 var()。
 *
 * 纯对象、不 import maplibre-gl，能在 node 里测。
 */

export const NETWORK_MAP_SOURCES = {
  countries: "nm-countries",
  /** 暗黑网格的经纬网（代码生成的线） */
  graticule: "nm-graticule",
  links: "nm-links",
  flows: "nm-flows",
  /** 备用线路经过的中转点：灰色小点 */
  waypoints: "nm-waypoints",
  /** 主线路上流动的光点，每帧 setData */
  particles: "nm-particles",
} as const;

/** 离线地球图的栅格源 / 图层 id */
export const TEXTURE_LAYER_IDS: Record<NetworkMapTextureId, string> = { night: "earth-night", day: "earth-day" };

export const NETWORK_MAP_LAYERS = {
  background: "nm-bg",
  land: "nm-land",
  graticule: "nm-graticule",
  borders: "nm-borders",
  flow: "nm-flow",
  /** 看不见的宽线：只给点击命中用（细线手指点不中） */
  linkHit: "nm-link-hit",
  /** 霓虹的光：宽、模糊、半透明 */
  linkGlow: "nm-link-glow",
  /** 备用 / 降级 / 中断：虚线的芯 */
  linkDashed: "nm-link-dashed",
  /** 主线路：实线的芯（入口 → 出口一点点渐亮） */
  linkMain: "nm-link-main",
  waypoints: "nm-waypoints",
  particleGlow: "nm-particle-glow",
  particleCore: "nm-particle-core",
} as const;

/** 四类线和落地流向的颜色：由画布从 CSS 变量里读出来再传进来 */
export type NetworkMapLineColors = {
  main: string;
  backup: string;
  degraded: string;
  down: string;
  /** 落地流向（出口 → 落地目标），和落地节点同一个紫 */
  flow: string;
  /** 光点的芯（近白） */
  particle: string;
};

/** 自绘底图的颜色：水、陆地、国界、经纬网 */
export type NetworkMapBaseColors = {
  water: string;
  land: string;
  border: string;
  graticule: string;
};

export function kindColorExpression(colors: NetworkMapLineColors) {
  return ["match", ["get", "kind"], "main", colors.main, "degraded", colors.degraded, "down", colors.down, colors.backup];
}

/**
 * 透明度乘上 feature-state：筛掉的（hide）不画，聚焦时无关的（dim）压到 12%。只改 feature-state，不重发数据。
 */
export function dimOpacityExpression(base: unknown) {
  return ["*", base, ["case", ["boolean", ["feature-state", "hide"], false], 0, ["boolean", ["feature-state", "dim"], false], 0.12, 1]];
}

/** 光的透明度：主线路亮一些，虚线的光淡一些（不然虚线的缝被光填满，看着像实线） */
export function glowOpacity() {
  return dimOpacityExpression(["match", ["get", "kind"], "main", 0.5, "down", 0.3, "degraded", 0.28, 0.16]);
}

/** 栅格源的 id（地球图 + 高德） */
export function rasterSourceIds(): string[] {
  return [TEXTURE_LAYER_IDS.night, TEXTURE_LAYER_IDS.day, ...NETWORK_MAP_ALL_BASE_LAYERS.flatMap((id) => NETWORK_MAP_BASE_LAYERS[id].tiles.map((tile) => tile.id))];
}

/** 某个底图激活时，每个栅格图层该不该显示 */
export function rasterVisibility(active: NetworkMapBaseLayerId): Record<string, "visible" | "none"> {
  const base = NETWORK_MAP_BASE_LAYERS[active];
  const out: Record<string, "visible" | "none"> = {};
  for (const texture of Object.keys(TEXTURE_LAYER_IDS) as NetworkMapTextureId[]) out[TEXTURE_LAYER_IDS[texture]] = base.texture === texture ? "visible" : "none";
  for (const id of NETWORK_MAP_ALL_BASE_LAYERS) {
    for (const tile of NETWORK_MAP_BASE_LAYERS[id].tiles) out[tile.id] = id === active ? "visible" : "none";
  }
  return out;
}

/**
 * 地球图只有 4096 像素宽，放大到 6 级以上就是一片糊掉的色块（首页的小窗常在 8、9 级）。所以放大时让它
 * 慢慢淡掉，底下自绘的深色陆地和国界慢慢显出来：远看是夜晚的地球，近看是干净的深色地图。
 */
export function zoomFade(from: number, to: number) {
  return ["interpolate", ["linear"], ["zoom"], 5, from, 8, to];
}

/**
 * 栅格的压色：
 *   夜光图  提对比和饱和度，城市灯光更橙更亮；透明度 0.9 —— 黑色的海透出底下的深海军蓝；灯光提亮、海压暗是瓦片拉伸时就调好的（gradeNightPixels）
 *   卫星图  压暗到四成多、降饱和：白天的图太亮，线路和光点压不住
 *   高德    反相（brightness-min > max）再转 180° 色相：白底街道图变成深底亮路，颜色还是原来的意思
 */
export function rasterTonePaint(rasterId: string): Record<string, unknown> {
  if (rasterId === TEXTURE_LAYER_IDS.night) return { "raster-opacity": zoomFade(0.9, 0.3), "raster-contrast": 0.08, "raster-saturation": 0.1, "raster-brightness-min": 0, "raster-brightness-max": 1 };
  if (rasterId === TEXTURE_LAYER_IDS.day) return { "raster-opacity": zoomFade(1, 0.35), "raster-contrast": 0.05, "raster-saturation": -0.3, "raster-brightness-min": 0, "raster-brightness-max": 0.46 };
  return { "raster-opacity": 1, "raster-contrast": -0.1, "raster-saturation": -0.65, "raster-brightness-min": 0.9, "raster-brightness-max": 0.06, "raster-hue-rotate": 180 };
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

/** 往白色混一点（认不出的写法原样返回） */
export function lighten(color: string, amount: number): string {
  const rgb = parseRgb(color);
  if (!rgb) return color;
  const mix = rgb.map((channel) => Math.round(channel + (255 - channel) * amount));
  return `#${mix.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * 主线路沿线一点点渐亮：入口是亮蓝，出口再亮一档 —— 光点停下来（减少动态）时也看得出从哪头出发。
 * 每一跳的坐标都是入口 → 出口（greatCircleArc(a, b)），line-progress 0 就是入口。源要开 lineMetrics。
 */
export function linkGradient(colors: NetworkMapLineColors) {
  return ["interpolate", ["linear"], ["line-progress"], 0, colors.main, 1, lighten(colors.main, 0.4)];
}

/** 经纬网：每 15° 一条，纬线到 ±75°；多段线，代码生成，不用拉文件 */
export function graticuleGeoJson(step = 15) {
  const lines: Array<Array<[number, number]>> = [];
  for (let lng = -180; lng <= 180; lng += step) {
    const line: Array<[number, number]> = [];
    for (let lat = -80; lat <= 80; lat += 5) line.push([lng, lat]);
    lines.push(line);
  }
  for (let lat = -75; lat <= 75; lat += step) {
    const line: Array<[number, number]> = [];
    for (let lng = -180; lng <= 180; lng += 5) line.push([lng, lat]);
    lines.push(line);
  }
  return { type: "FeatureCollection" as const, features: [{ type: "Feature" as const, properties: {}, geometry: { type: "MultiLineString" as const, coordinates: lines } }] };
}

export function buildNetworkMapStyle(active: NetworkMapBaseLayerId, countriesUrl: string, colors: NetworkMapLineColors, base: NetworkMapBaseColors) {
  const visibility = rasterVisibility(active);
  const patch = baseLayerPaintPatch(active);
  const emptyCollection = { type: "FeatureCollection" as const, features: [] as never[] };
  const sources: Record<string, any> = {
    [NETWORK_MAP_SOURCES.countries]: { type: "geojson", data: countriesUrl },
    [NETWORK_MAP_SOURCES.graticule]: { type: "geojson", data: graticuleGeoJson() },
    // promoteId：feature-state 要按 fid 找要素，不用 generateId 那种会随 setData 变的序号；
    // lineMetrics：主线路的渐变按 line-progress 画
    [NETWORK_MAP_SOURCES.links]: { type: "geojson", data: emptyCollection, promoteId: "fid", lineMetrics: true },
    [NETWORK_MAP_SOURCES.flows]: { type: "geojson", data: emptyCollection, promoteId: "fid" },
    [NETWORK_MAP_SOURCES.waypoints]: { type: "geojson", data: emptyCollection, promoteId: "fid" },
    [NETWORK_MAP_SOURCES.particles]: { type: "geojson", data: emptyCollection },
  };
  const rasterLayers: any[] = [];
  for (const texture of Object.keys(TEXTURE_LAYER_IDS) as NetworkMapTextureId[]) {
    const id = TEXTURE_LAYER_IDS[texture];
    // 地球图按瓦片现拉伸（components/network/earthTiles.ts 注册的协议），最多切到第 4 级，再往上 MapLibre 自己放大
    sources[id] = { type: "raster", tiles: [textureTileUrl(texture)], tileSize: 256, maxzoom: NETWORK_MAP_TEXTURE_MAX_ZOOM };
    rasterLayers.push({ id, type: "raster", source: id, layout: { visibility: visibility[id] }, paint: { "raster-fade-duration": 0, ...rasterTonePaint(id) } });
  }
  for (const layerId of NETWORK_MAP_ALL_BASE_LAYERS) {
    for (const tile of NETWORK_MAP_BASE_LAYERS[layerId].tiles) {
      sources[tile.id] = { type: "raster", tiles: tile.urls, tileSize: tile.tileSize, maxzoom: tile.maxzoom };
      // 切换时不淡入：底图一换点和线要同时换坐标（GCJ-02），淡入会让线先到、图后到
      rasterLayers.push({ id: tile.id, type: "raster", source: tile.id, layout: { visibility: visibility[tile.id] }, paint: { "raster-fade-duration": 0, ...rasterTonePaint(tile.id) } });
    }
  }
  const kindColor = kindColorExpression(colors);
  return {
    version: 8 as const,
    sources,
    layers: [
      { id: NETWORK_MAP_LAYERS.background, type: "background", paint: { "background-color": base.water } },
      ...rasterLayers,
      { id: NETWORK_MAP_LAYERS.land, type: "fill", source: NETWORK_MAP_SOURCES.countries, paint: { "fill-color": base.land, "fill-opacity": patch.landOpacity } },
      { id: NETWORK_MAP_LAYERS.graticule, type: "line", source: NETWORK_MAP_SOURCES.graticule, layout: { visibility: patch.graticule }, paint: { "line-color": base.graticule, "line-width": 0.6 } },
      { id: NETWORK_MAP_LAYERS.borders, type: "line", source: NETWORK_MAP_SOURCES.countries, layout: { "line-join": "round" }, paint: { "line-color": base.border, "line-width": patch.borderWidth, "line-opacity": patch.borderOpacity } },
      // 落地流向：出口 → 落地目标的紫色细虚线，带一点光
      { id: NETWORK_MAP_LAYERS.flow, type: "line", source: NETWORK_MAP_SOURCES.flows, paint: { "line-color": colors.flow, "line-width": 1.2, "line-opacity": dimOpacityExpression(0.75), "line-dasharray": [1.5, 2.5] } },
      { id: NETWORK_MAP_LAYERS.linkHit, type: "line", source: NETWORK_MAP_SOURCES.links, paint: { "line-color": kindColor, "line-width": 14, "line-opacity": 0 } },
      { id: NETWORK_MAP_LAYERS.linkGlow, type: "line", source: NETWORK_MAP_SOURCES.links, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": kindColor, "line-width": ["match", ["get", "kind"], "main", 9, 7], "line-blur": 6, "line-opacity": glowOpacity() } },
      { id: NETWORK_MAP_LAYERS.linkMain, type: "line", source: NETWORK_MAP_SOURCES.links, filter: ["==", ["get", "kind"], "main"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-gradient": linkGradient(colors), "line-width": 2, "line-opacity": dimOpacityExpression(1) } },
      // 虚线压在主线路上面：出问题的线、备用线和主线路走同一段时不能被盖住
      { id: NETWORK_MAP_LAYERS.linkDashed, type: "line", source: NETWORK_MAP_SOURCES.links, filter: ["!=", ["get", "kind"], "main"], layout: { "line-join": "round" }, paint: { "line-color": kindColor, "line-width": 1.6, "line-opacity": dimOpacityExpression(["match", ["get", "kind"], "backup", 0.75, 1]), "line-dasharray": [3, 2.5] } },
      { id: NETWORK_MAP_LAYERS.waypoints, type: "circle", source: NETWORK_MAP_SOURCES.waypoints, paint: { "circle-radius": 2.6, "circle-color": colors.backup, "circle-opacity": dimOpacityExpression(0.85), "circle-stroke-width": 1, "circle-stroke-color": base.water, "circle-stroke-opacity": dimOpacityExpression(0.9) } },
      // 光点：一圈淡淡的光 + 一颗近白的芯
      { id: NETWORK_MAP_LAYERS.particleGlow, type: "circle", source: NETWORK_MAP_SOURCES.particles, paint: { "circle-radius": 6, "circle-color": colors.main, "circle-opacity": 0.45, "circle-blur": 1 } },
      { id: NETWORK_MAP_LAYERS.particleCore, type: "circle", source: NETWORK_MAP_SOURCES.particles, paint: { "circle-radius": 1.8, "circle-color": colors.particle, "circle-opacity": 0.95 } },
    ],
  };
}

/** 换底图时要改的那几项（不重建样式）：自绘陆地、经纬网、国界、栅格的可见性和压色 */
export function baseLayerPaintPatch(active: NetworkMapBaseLayerId) {
  const base = NETWORK_MAP_BASE_LAYERS[active];
  const raster = rasterVisibility(active);
  // 地球图上：远看不画陆地、国界淡淡一道（夜光）或不画（卫星）；放大到地球图糊掉时陆地和国界接上来
  const landOpacity: unknown = base.land ? 1 : base.texture ? zoomFade(0, 1) : 0;
  const borderOpacity: unknown = base.land ? 1 : base.texture === "night" ? zoomFade(0.5, 1) : base.texture === "day" ? zoomFade(0, 1) : 0;
  return {
    landOpacity,
    borderWidth: base.texture ? 0.5 : base.borderWidth,
    borderOpacity,
    graticule: (base.graticule ? "visible" : "none") as "visible" | "none",
    raster,
    rasterPaint: Object.fromEntries(Object.keys(raster).map((id) => [id, rasterTonePaint(id)])),
  };
}
