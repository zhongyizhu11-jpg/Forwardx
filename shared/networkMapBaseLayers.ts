/**
 * 网络地图的三种底图。
 *
 *   简洁      不用瓦片：Natural Earth 国界自绘，淡色陆地 + 稍深 / 稍浅的水面 + 0.5px 低对比国界，
 *             浅色主题像纸，深色主题是深石板色的水和略亮的陆地。默认就是它 —— 内网、被墙、断网都画得出来，
 *             也不跟线路、主机抢颜色。
 *   高德标准  高德栅格瓦片（style=7）
 *   高德卫星  高德影像（style=6）+ 路网标注叠加（style=8）
 *
 * 高德两种都压低了饱和度和对比度（深色主题下标准图再整体压暗），不然瓦片本身的颜色比线和主机还抢眼。
 *
 * 界面皮肤：简洁和高德标准跟着面板主题走（深色主题下标准图压暗了，深色玻璃压得住）；卫星影像本来就暗，
 * 永远配深色玻璃 —— 浅色玻璃在影像上发灰、字也看不清。
 *
 * 颜色（水、陆地、国界）不写在这里：它们是 networkMap.css 里按皮肤定的 --nm-* 令牌，画布从 CSS 读出来
 * 再交给 MapLibre，浅色 / 深色各一套、和面板其它地方同一个来源。
 *
 * 高德瓦片不用申请 key 就能拉，但条款要求商用取 key —— 图层菜单底下写着这句。
 */

export type NetworkMapBaseLayerId = "vector" | "light" | "sat";
export type NetworkMapSkin = "light" | "dark";

export type NetworkMapBaseLayer = {
  id: NetworkMapBaseLayerId;
  label: string;
  hint: string;
  /** 界面皮肤：theme = 跟面板主题；dark = 永远深色 */
  skin: "theme" | "dark";
  /** 底图要不要走高德瓦片（要的话点要先转 GCJ-02） */
  amap: boolean;
  /** 栅格瓦片源：[底层, 叠加层…]，简洁底图没有 */
  tiles: Array<{ id: string; urls: string[]; tileSize: number; maxzoom: number }>;
  /** 自绘的陆地、国界画不画（高德瓦片自己有） */
  vector: boolean;
};

const AMAP_HOSTS = ["01", "02", "03", "04"];
const amapUrls = (host: "webrd" | "webst", query: string) => AMAP_HOSTS.map((n) => `https://${host}${n}.is.autonavi.com/appmaptile?${query}`);

export const NETWORK_MAP_BASE_LAYERS: Record<NetworkMapBaseLayerId, NetworkMapBaseLayer> = {
  vector: {
    id: "vector",
    label: "简洁",
    hint: "离线矢量 · 跟随主题",
    skin: "theme",
    amap: false,
    tiles: [],
    vector: true,
  },
  light: {
    id: "light",
    label: "高德标准",
    hint: "街道与地名",
    skin: "theme",
    amap: true,
    tiles: [{ id: "amap-road", urls: amapUrls("webrd", "lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}"), tileSize: 256, maxzoom: 18 }],
    vector: false,
  },
  sat: {
    id: "sat",
    label: "高德卫星",
    hint: "影像 + 路网 · 深色界面",
    skin: "dark",
    amap: true,
    tiles: [
      { id: "amap-sat", urls: amapUrls("webst", "style=6&x={x}&y={y}&z={z}"), tileSize: 256, maxzoom: 18 },
      { id: "amap-sat-labels", urls: amapUrls("webst", "x={x}&y={y}&z={z}&lang=zh_cn&size=1&scale=1&style=8"), tileSize: 256, maxzoom: 18 },
    ],
    vector: false,
  },
};

export const NETWORK_MAP_BASE_LAYER_ORDER: NetworkMapBaseLayerId[] = ["vector", "light", "sat"];

export const NETWORK_MAP_LAYER_STORAGE_KEY = "forwardx.networkMap.baseLayer";

export const NETWORK_MAP_AMAP_TERMS_NOTE = "高德瓦片仅供自用面板；商用请申请高德 key";

export function isNetworkMapBaseLayerId(value: unknown): value is NetworkMapBaseLayerId {
  return value === "vector" || value === "light" || value === "sat";
}

/** 没记住过时的默认：简洁底图，浅色 / 深色主题都是它（皮肤跟主题走）。 */
export function defaultNetworkMapBaseLayer(): NetworkMapBaseLayerId {
  return "vector";
}

/**
 * 记住的优先（只有用户在图层菜单里亲手点过才会写这个键）：点过高德标准 / 卫星的照旧；
 * 老版本的「暗黑网格」（dark）已经由简洁底图取代，记着它的也落到简洁底图；坏值退回默认。
 */
export function resolveNetworkMapBaseLayer(stored: unknown): NetworkMapBaseLayerId {
  if (stored === "dark") return "vector";
  return isNetworkMapBaseLayerId(stored) ? stored : defaultNetworkMapBaseLayer();
}

/** 这张底图在这个面板主题下配哪套皮肤 */
export function networkMapSkin(id: NetworkMapBaseLayerId, theme: "dark" | "light"): NetworkMapSkin {
  return NETWORK_MAP_BASE_LAYERS[id].skin === "dark" ? "dark" : theme;
}
