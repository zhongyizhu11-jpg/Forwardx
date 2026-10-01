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
  /**
   * 夜光图那一套的水和陆地（--nm-night-water / --nm-night-land）：地球图淡出之后接上来的矢量底图、
   * 首页小窗都用它，颜色和夜光图里近黑的海、陆地对得上，放大缩小时不会突然换一种蓝。没给就用 water / land
   */
  nightWater?: string;
  nightLand?: string;
};

/** 换底图 / 建样式时的选项 */
export type BaseLayerOptions = {
  /**
   * 只画矢量的陆地和水，不画任何栅格（首页的小窗）：小窗常在 7 ~ 9 级，地球图只有 4096 像素宽，放到这里
   * 是一片糊；高德的街道图在一百多像素的窗里也只是噪点。
   */
  vectorOnly?: boolean;
};

/** 某种底图下矢量底图用哪套颜色：地球图（夜光 / 卫星）和小窗用夜光那套，暗黑网格和高德用自己的 */
export function baseColorsFor(active: NetworkMapBaseLayerId, base: NetworkMapBaseColors, options: BaseLayerOptions = {}): NetworkMapBaseColors {
  const night = options.vectorOnly || NETWORK_MAP_BASE_LAYERS[active].texture !== null;
  if (!night) return base;
  return { ...base, water: base.nightWater ?? base.water, land: base.nightLand ?? base.land };
}

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

/** 某个底图激活时，每个栅格图层该不该显示（vectorOnly：全都不显示） */
export function rasterVisibility(active: NetworkMapBaseLayerId, options: BaseLayerOptions = {}): Record<string, "visible" | "none"> {
  const base = NETWORK_MAP_BASE_LAYERS[active];
  const out: Record<string, "visible" | "none"> = {};
  for (const texture of Object.keys(TEXTURE_LAYER_IDS) as NetworkMapTextureId[]) out[TEXTURE_LAYER_IDS[texture]] = !options.vectorOnly && base.texture === texture ? "visible" : "none";
  for (const id of NETWORK_MAP_ALL_BASE_LAYERS) {
    for (const tile of NETWORK_MAP_BASE_LAYERS[id].tiles) out[tile.id] = !options.vectorOnly && id === active ? "visible" : "none";
  }
  return out;
}

/**
 * 地球图在这两级之间淡出、矢量的陆地和国界淡入；到 TEXTURE_LAYER_MAX_ZOOM 地球图图层就不画了（图层的
 * maxzoom：MapLibre 连瓦片都不再要）。
 *
 * 地球图只有 4096 像素宽，4 级就是原图的分辨率，再往上全是 MapLibre 拉大的同一块像素：上一版让它一直
 * 淡到 8 级还留着三成，首页小窗（7 ~ 9 级）里就是一层糊掉的色块叠在矢量陆地上。现在 5.5 级以上只剩矢量。
 */
export const TEXTURE_FADE_ZOOM: readonly [number, number] = [4.5, 5.5];
export const TEXTURE_LAYER_MAX_ZOOM = TEXTURE_FADE_ZOOM[1];

export function zoomFade(from: number, to: number) {
  return ["interpolate", ["linear"], ["zoom"], TEXTURE_FADE_ZOOM[0], from, TEXTURE_FADE_ZOOM[1], to];
}

/**
 * 陆地和国界用的是 Natural Earth 1:110m 的国界，6 级以上就和真实海岸线对不上了 —— 珠江口在它里面是一个
 * 几十公里的三角形缺口，首页小窗框港粤几台时正好在窗的左下角，看着像一块深色的三角形接缝（以前以为是
 * 地球图瓦片的缝，其实是它）。所以 5.5 → 7 级之间把陆地和国界淡到很淡：放大以后底图只剩一层均匀的深色，
 * 粗糙的海岸线不再画出一个假的形状；缩小时它们照常是一张世界地图。
 */
export const COARSE_COAST_ZOOM: readonly [number, number] = [5.5, 7];
const COARSE_COAST_FLOOR = { land: 0.15, border: 0.15 };
/** 首页小窗（vectorOnly）的那一段：4 → 6 级 */
export const INSET_COAST_ZOOM: readonly [number, number] = [4, 6];

/** 陆地 / 国界的透明度：给出地球图淡出时（或没有地球图时）的满值，自动接上 6 级以上的淡出 */
function vectorOpacity(full: number, floor: number, overTexture: number | null): unknown {
  const fade = ["interpolate", ["linear"], ["zoom"]] as unknown[];
  // 有地球图：4.5 级以前是 overTexture（夜光图上一道淡国界、卫星图上不画），5.5 级接满
  if (overTexture !== null) fade.push(TEXTURE_FADE_ZOOM[0], overTexture, TEXTURE_FADE_ZOOM[1], full);
  // MapLibre 要求插值的级别严格递增：地球图淡没的那一级和粗海岸线开始淡的那一级重合时只留一个
  if (fade[fade.length - 2] !== COARSE_COAST_ZOOM[0]) fade.push(COARSE_COAST_ZOOM[0], full);
  fade.push(COARSE_COAST_ZOOM[1], full * floor);
  return fade;
}

/**
 * 栅格的压色：
 *   夜光图  提对比和饱和度，城市灯光更橙更亮；透明度 0.9 —— 黑色的海透出底下的深海军蓝；灯光提亮、海压暗是瓦片拉伸时就调好的（gradeNightPixels）
 *   卫星图  压暗到四成多、降饱和：白天的图太亮，线路和光点压不住
 *   两张地球图都在 4.5 → 5.5 级淡到 0（zoomFade），之后只剩矢量底图
 *   高德    反相（brightness-min > max）再转 180° 色相：白底街道图变成深底亮路，颜色还是原来的意思
 */
export function rasterTonePaint(rasterId: string): Record<string, unknown> {
  if (rasterId === TEXTURE_LAYER_IDS.night) return { "raster-opacity": zoomFade(0.9, 0), "raster-contrast": 0.08, "raster-saturation": 0.1, "raster-brightness-min": 0, "raster-brightness-max": 1 };
  if (rasterId === TEXTURE_LAYER_IDS.day) return { "raster-opacity": zoomFade(1, 0), "raster-contrast": 0.05, "raster-saturation": -0.3, "raster-brightness-min": 0, "raster-brightness-max": 0.46 };
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

export function buildNetworkMapStyle(active: NetworkMapBaseLayerId, countriesUrl: string, colors: NetworkMapLineColors, baseColors: NetworkMapBaseColors, options: BaseLayerOptions = {}) {
  const visibility = rasterVisibility(active, options);
  const patch = baseLayerPaintPatch(active, options);
  const base = baseColorsFor(active, baseColors, options);
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
    // maxzoom：5.5 级以上地球图已经淡没了，图层直接不画、也不再要瓦片（不留一层糊掉的像素）
    rasterLayers.push({ id, type: "raster", source: id, maxzoom: TEXTURE_LAYER_MAX_ZOOM, layout: { visibility: visibility[id] }, paint: { "raster-fade-duration": 0, ...rasterTonePaint(id) } });
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

/**
 * 换底图时要改的那几项（不重建样式）：自绘陆地、经纬网、国界、栅格的可见性和压色。
 * vectorOnly（首页小窗）：不画任何栅格，只画矢量的陆地和水（暗黑网格那套陆地，不要经纬网，颜色是夜光那套）。
 */
export function baseLayerPaintPatch(active: NetworkMapBaseLayerId, options: BaseLayerOptions = {}) {
  const base = NETWORK_MAP_BASE_LAYERS[active];
  const raster = rasterVisibility(active, options);
  if (options.vectorOnly) {
    // 小窗几乎总在 6 级以上（它就是用来放大挤在一起的几台的），粗海岸线在这里最显眼：提前一级半淡下去，
    // 到 6 级只剩一层均匀的深色（缩得很小的小窗，比如两台隔着半个国家，陆地还在）
    return {
      landOpacity: ["interpolate", ["linear"], ["zoom"], INSET_COAST_ZOOM[0], 1, INSET_COAST_ZOOM[1], COARSE_COAST_FLOOR.land],
      borderWidth: 0.5,
      borderOpacity: ["interpolate", ["linear"], ["zoom"], INSET_COAST_ZOOM[0], 0.6, INSET_COAST_ZOOM[1], 0.6 * COARSE_COAST_FLOOR.border],
      graticule: "none" as "visible" | "none",
      raster,
      rasterPaint: Object.fromEntries(Object.keys(raster).map((id) => [id, rasterTonePaint(id)])),
    };
  }
  // 地球图上：远看不画陆地、国界淡淡一道（夜光）或不画（卫星）；地球图淡出时陆地和国界接上来；再放大都淡下去（粗海岸线）
  const landOpacity: unknown = base.land ? vectorOpacity(1, COARSE_COAST_FLOOR.land, null) : base.texture ? vectorOpacity(1, COARSE_COAST_FLOOR.land, 0) : 0;
  const borderOpacity: unknown = base.land ? vectorOpacity(1, COARSE_COAST_FLOOR.border, null) : base.texture === "night" ? vectorOpacity(1, COARSE_COAST_FLOOR.border, 0.5) : base.texture === "day" ? vectorOpacity(1, COARSE_COAST_FLOOR.border, 0) : 0;
  return {
    landOpacity,
    borderWidth: base.texture ? 0.5 : base.borderWidth,
    borderOpacity,
    graticule: (base.graticule ? "visible" : "none") as "visible" | "none",
    raster,
    rasterPaint: Object.fromEntries(Object.keys(raster).map((id) => [id, rasterTonePaint(id)])),
  };
}
