/**
 * 网络地图的底图。
 *
 *   标准地图  夜晚的地球：NASA Black Marble 夜光图（client/public/globe/earth-night.jpg），近黑的陆地上
 *             一片片橙黄的城市灯光、深海军蓝的海。默认就是它 —— 离线、不拉瓦片，内网和被墙都画得出来，
 *             线路和主机的霓虹色在它上面最显眼。
 *   卫星地图  白天的卫星图：Blue Marble（earth-blue-marble.jpg），压暗、降饱和，不跟线路抢颜色。
 *   暗黑网格  不用图片：Natural Earth 国界自绘成深色陆地，压一层很淡的青色经纬网。
 *   高德地图  高德栅格瓦片（style=7）反相成深色：要街道和中文地名时用。不在三段切换里，只在图层菜单里。
 *
 * 两张地球图都是等经纬投影（经度、纬度各自均分），MapLibre 要的是 Web 墨卡托：画布那边注册了一个
 * 自定义协议（components/network/earthTiles.ts），按瓦片现拉伸 —— 只拉看得见的那几块，世界副本也照常
 * 平铺；拉伸的数学在 shared/networkMapTexture.ts。图本身只在第一次画地图时下载一次。
 *
 * 地图这块永远是深色的，像嵌在面板里的一块屏幕：浅色主题下面板的边框、抽屉跟主题走，图上不跟。
 * 所以这里不再有「皮肤跟底图走」那一套；底图、线路、玻璃的颜色都是 networkMap.css 里 .nm-surface
 * 的 --nm-* 令牌。
 *
 * 高德瓦片不用申请 key 就能拉，但条款要求商用取 key —— 图层菜单底下写着这句。
 */

export type NetworkMapBaseLayerId = "night" | "sat" | "grid" | "amap";
/** 面板主题：只管地图四周的抽屉、卡片，地图本身永远深色 */
export type NetworkMapSkin = "light" | "dark";

/** 两张离线地球图 */
export type NetworkMapTextureId = "night" | "day";

export type NetworkMapBaseLayer = {
  id: NetworkMapBaseLayerId;
  label: string;
  hint: string;
  /** 底图要不要走高德瓦片（要的话点要先转 GCJ-02） */
  amap: boolean;
  /** 高德的栅格瓦片源，别的底图没有 */
  tiles: Array<{ id: string; urls: string[]; tileSize: number; maxzoom: number }>;
  /** 离线地球图（按瓦片现拉伸成墨卡托），null = 不用 */
  texture: NetworkMapTextureId | null;
  /** 自绘的陆地画不画（暗黑网格画；夜光、卫星、高德的图里自带） */
  land: boolean;
  /** 国界线画不画、多粗（夜光图上画一道很淡的帮着认国家） */
  borderWidth: number;
  /** 青色经纬网（只有暗黑网格） */
  graticule: boolean;
};

const AMAP_HOSTS = ["01", "02", "03", "04"];
const amapUrls = (host: "webrd" | "webst", query: string) => AMAP_HOSTS.map((n) => `https://${host}${n}.is.autonavi.com/appmaptile?${query}`);

/** 自定义协议的前缀：`fxearth://night/{z}/{x}/{y}` */
export const NETWORK_MAP_TEXTURE_PROTOCOL = "fxearth";

/** 两张地球图的地址（4096 × 2048 等经纬图）；协议按名字找图 */
export const NETWORK_MAP_TEXTURE_URLS: Record<NetworkMapTextureId, string> = {
  night: "/globe/earth-night.jpg",
  day: "/globe/earth-blue-marble.jpg",
};

/**
 * 地球图的瓦片最多切到第几级：图宽 4096 像素，第 4 级整个世界正好 16 × 256 = 4096 像素宽，
 * 再往上放大就是把同一块像素拉大（MapLibre 自己 overzoom），切更细的瓦片也不会更清楚。
 */
export const NETWORK_MAP_TEXTURE_MAX_ZOOM = 4;

export function textureTileUrl(texture: NetworkMapTextureId): string {
  return `${NETWORK_MAP_TEXTURE_PROTOCOL}://${texture}/{z}/{x}/{y}`;
}

export const NETWORK_MAP_BASE_LAYERS: Record<NetworkMapBaseLayerId, NetworkMapBaseLayer> = {
  night: {
    id: "night",
    label: "标准地图",
    hint: "夜晚的地球 · 城市灯光",
    amap: false,
    tiles: [],
    texture: "night",
    land: false,
    borderWidth: 0.5,
    graticule: false,
  },
  sat: {
    id: "sat",
    label: "卫星地图",
    hint: "白天的卫星图 · 压暗",
    amap: false,
    tiles: [],
    texture: "day",
    land: false,
    borderWidth: 0,
    graticule: false,
  },
  grid: {
    id: "grid",
    label: "暗黑网格",
    hint: "矢量国界 · 青色经纬网",
    amap: false,
    tiles: [],
    texture: null,
    land: true,
    borderWidth: 0.6,
    graticule: true,
  },
  amap: {
    id: "amap",
    label: "高德地图",
    hint: "街道与中文地名 · 反相成深色",
    amap: true,
    tiles: [{ id: "amap-road", urls: amapUrls("webrd", "lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}"), tileSize: 256, maxzoom: 18 }],
    texture: null,
    land: false,
    borderWidth: 0,
    graticule: false,
  },
};

/** 图上右上角那个三段切换 */
export const NETWORK_MAP_BASE_LAYER_ORDER: NetworkMapBaseLayerId[] = ["night", "sat", "grid"];
/** 图层菜单里多出来的（要联网、有条款） */
export const NETWORK_MAP_EXTRA_BASE_LAYERS: NetworkMapBaseLayerId[] = ["amap"];
export const NETWORK_MAP_ALL_BASE_LAYERS: NetworkMapBaseLayerId[] = [...NETWORK_MAP_BASE_LAYER_ORDER, ...NETWORK_MAP_EXTRA_BASE_LAYERS];

/**
 * 记住的底图存在哪（首页卡片和 /map 整页读写的是同一个键）。
 *
 * 带版本号：重新设计之前存的值（旧键 forwardx.networkMap.baseLayer）多半不是用户冲着现在这几张底图挑的 ——
 * 老版本的「卫星」是高德卫星，被映射成了现在压暗的白天卫星图，用户的首页就成了一张发白的雪地图，不是
 * 设计里的夜晚地球。所以换一个新键：所有人第一次都从标准地图开始，之后亲手点过的才记在新键下面。
 * 旧键读到就顺手删掉，不再看它。
 */
export const NETWORK_MAP_LAYER_STORAGE_KEY = "forwardx.networkMap.baseLayer.v2";
export const NETWORK_MAP_LEGACY_LAYER_STORAGE_KEYS = ["forwardx.networkMap.baseLayer"] as const;

type LayerStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** 页面打开时读一次：只认新键（没有就是标准地图），旧键删掉。存储不可用（隐私模式、被禁用）当没记过 */
export function readNetworkMapBaseLayer(storage: LayerStorage | null | undefined): NetworkMapBaseLayerId {
  if (!storage) return defaultNetworkMapBaseLayer();
  for (const key of NETWORK_MAP_LEGACY_LAYER_STORAGE_KEYS) {
    try { storage.removeItem(key); } catch { /* 删不掉也不要紧：再也不读它 */ }
  }
  try { return resolveNetworkMapBaseLayer(storage.getItem(NETWORK_MAP_LAYER_STORAGE_KEY)); } catch { return defaultNetworkMapBaseLayer(); }
}

/** 用户在图层里亲手点了一个：记在新键下面（只有这里写） */
export function rememberNetworkMapBaseLayer(storage: LayerStorage | null | undefined, id: NetworkMapBaseLayerId): void {
  try { storage?.setItem(NETWORK_MAP_LAYER_STORAGE_KEY, id); } catch { /* 存不了就下次再默认 */ }
}

/** 浏览器里的 localStorage；拿不到（SSR、被禁用）是 null */
export function browserLayerStorage(): LayerStorage | null {
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}

export const NETWORK_MAP_AMAP_TERMS_NOTE = "高德瓦片仅供自用面板；商用请申请高德 key";

export function isNetworkMapBaseLayerId(value: unknown): value is NetworkMapBaseLayerId {
  return value === "night" || value === "sat" || value === "grid" || value === "amap";
}

/** 没记住过时的默认：夜晚的地球。 */
export function defaultNetworkMapBaseLayer(): NetworkMapBaseLayerId {
  return "night";
}

/**
 * 记住的优先（只有用户在图层里亲手点过才会写这个键）。老版本存过的值换成现在的叫法：
 *   vector（上一版的「简洁」）→ 标准地图：它就是那一版的默认，换了新默认就跟着换
 *   dark（更早的「暗黑网格」）→ 暗黑网格，还是那个意思
 *   light（高德标准）→ 高德地图
 *   sat（以前是高德卫星）→ 卫星地图，现在是离线的那张
 * 认不出的退回默认。
 */
export function resolveNetworkMapBaseLayer(stored: unknown): NetworkMapBaseLayerId {
  if (stored === "vector") return "night";
  if (stored === "dark") return "grid";
  if (stored === "light") return "amap";
  return isNetworkMapBaseLayerId(stored) ? stored : defaultNetworkMapBaseLayer();
}
