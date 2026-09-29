/**
 * 网络地图的三种底图。
 *
 *   标准图    高德栅格瓦片（style=7），浅色界面
 *   卫星      高德影像（style=6）+ 路网标注叠加（style=8），深色界面
 *   暗黑网格  不用瓦片：#0B0F19 底、Natural Earth 国界、15° 经纬网格，深色界面
 *
 * 界面皮肤跟着底图走而不是跟着面板主题：浅色主题下切到卫星图，深色玻璃卡片才压得住
 * 影像；深色主题下切到标准图，白底瓦片配深色卡片会像贴了块黑膏药。
 *
 * 高德瓦片不用申请 key 就能拉，但条款要求商用取 key —— 图层菜单底下写着这句。
 */

export type NetworkMapBaseLayerId = "light" | "dark" | "sat";
export type NetworkMapSkin = "light" | "dark";

export type NetworkMapBaseLayer = {
  id: NetworkMapBaseLayerId;
  label: string;
  hint: string;
  skin: NetworkMapSkin;
  /** 底图要不要走高德瓦片（要的话点要先转 GCJ-02） */
  amap: boolean;
  /** 栅格瓦片源：[底层, 叠加层…]，暗黑网格没有 */
  tiles: Array<{ id: string; urls: string[]; tileSize: number; maxzoom: number }>;
  /** 矢量部分的颜色 */
  water: string;
  land: string;
  landOpacity: number;
  border: string;
  borderWidth: number;
  graticule: boolean;
};

const AMAP_HOSTS = ["01", "02", "03", "04"];
const amapUrls = (host: "webrd" | "webst", query: string) => AMAP_HOSTS.map((n) => `https://${host}${n}.is.autonavi.com/appmaptile?${query}`);

export const NETWORK_MAP_BASE_LAYERS: Record<NetworkMapBaseLayerId, NetworkMapBaseLayer> = {
  light: {
    id: "light",
    label: "标准图",
    hint: "高德 · 浅色界面",
    skin: "light",
    amap: true,
    tiles: [{ id: "amap-road", urls: amapUrls("webrd", "lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}"), tileSize: 256, maxzoom: 18 }],
    water: "#B7D6F0",
    land: "#F4F3EE",
    landOpacity: 0,
    border: "rgba(15,23,42,0)",
    borderWidth: 0,
    graticule: false,
  },
  sat: {
    id: "sat",
    label: "卫星",
    hint: "高德影像 + 路网 · 深色界面",
    skin: "dark",
    amap: true,
    tiles: [
      { id: "amap-sat", urls: amapUrls("webst", "style=6&x={x}&y={y}&z={z}"), tileSize: 256, maxzoom: 18 },
      { id: "amap-sat-labels", urls: amapUrls("webst", "x={x}&y={y}&z={z}&lang=zh_cn&size=1&scale=1&style=8"), tileSize: 256, maxzoom: 18 },
    ],
    water: "#061321",
    land: "#141B2D",
    landOpacity: 0,
    border: "rgba(255,255,255,0)",
    borderWidth: 0,
    graticule: false,
  },
  dark: {
    id: "dark",
    label: "暗黑网格",
    hint: "#0B0F19 · 国界与经纬网格",
    skin: "dark",
    amap: false,
    tiles: [],
    water: "#0B0F19",
    land: "#141B2D",
    landOpacity: 1,
    border: "rgba(6,182,212,0.38)",
    borderWidth: 0.7,
    graticule: true,
  },
};

export const NETWORK_MAP_BASE_LAYER_ORDER: NetworkMapBaseLayerId[] = ["light", "dark", "sat"];

export const NETWORK_MAP_LAYER_STORAGE_KEY = "forwardx.networkMap.baseLayer";

export const NETWORK_MAP_AMAP_TERMS_NOTE = "高德瓦片仅供自用面板；商用请申请高德 key";

export function isNetworkMapBaseLayerId(value: unknown): value is NetworkMapBaseLayerId {
  return value === "light" || value === "dark" || value === "sat";
}

/** 没记住过时的默认：跟面板主题走，深色 → 暗黑网格，浅色 → 标准图。 */
export function defaultNetworkMapBaseLayer(theme: "dark" | "light"): NetworkMapBaseLayerId {
  return theme === "dark" ? "dark" : "light";
}

/** 记住的优先，记的是坏值（老版本、手改过）就退回默认。 */
export function resolveNetworkMapBaseLayer(stored: unknown, theme: "dark" | "light"): NetworkMapBaseLayerId {
  return isNetworkMapBaseLayerId(stored) ? stored : defaultNetworkMapBaseLayer(theme);
}

/** 15° 经纬网格（暗黑网格底图那几条淡青线）。 */
export function graticuleGeoJson(step = 15) {
  const lines: Array<Array<[number, number]>> = [];
  for (let lng = -180; lng <= 180; lng += step) lines.push([[lng, -80], [lng, 80]]);
  for (let lat = -75; lat <= 75; lat += step) lines.push([[-180, lat], [180, lat]]);
  return {
    type: "FeatureCollection" as const,
    features: [{ type: "Feature" as const, properties: {}, geometry: { type: "MultiLineString" as const, coordinates: lines } }],
  };
}
