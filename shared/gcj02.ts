/**
 * WGS-84 → GCJ-02（「火星坐标」）。
 *
 * IP 定位给的坐标是 WGS-84，高德的瓦片是 GCJ-02。大陆境内两者差几百米：城市级看不出，
 * 放大到街区一台广州的机器会漂到隔壁马路上。所以高德底图下每个点先过这一步；
 * 暗黑网格底图用的是 Natural Earth 的国界（WGS-84），不转。
 *
 * 港澳台和海外不加偏 —— 高德对这些地区的瓦片本来就是 WGS-84，再转反而错。
 * 这里的「大陆」判断是一个粗矩形减去港澳台三个小矩形；边界上差几公里无所谓，
 * 那里的偏移量本来就接近零。
 */

const PI = Math.PI;
const A = 6378245.0;
const EE = 0.00669342162296594323;

function transformLat(x: number, y: number) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x: number, y: number) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

type Box = { west: number; east: number; south: number; north: number };

/*
  大陆的粗矩形。经典写法南界取 0.83°（把南海诸岛算进去），但那会把新加坡、马来西亚、
  越南南部一起当成大陆 —— 服务器只会在陆地上，南界取到海南岛南端（18.1°）就够了。
*/
const MAINLAND: Box = { west: 72.004, east: 137.8347, south: 18.0, north: 55.8271 };
/**
 * 不加偏的地区：香港、澳门、台湾，再加上矩形里顺带框进来的韩国和日本西部。
 * 矩形故意留了点余量，宁可少转一台也别把香港转歪。
 */
const EXCLUDED: Box[] = [
  { west: 113.76, east: 114.51, south: 22.13, north: 22.58 }, // 香港
  { west: 113.52, east: 113.63, south: 22.06, north: 22.23 }, // 澳门
  { west: 119.3, east: 122.3, south: 21.7, north: 25.5 }, // 台湾
  { west: 124.5, east: 131.5, south: 33.0, north: 39.0 }, // 韩国（丹东在 124.39，刚好在外）
  { west: 129.0, east: 138.0, south: 30.0, north: 42.0 }, // 日本西部（珲春 42.86，在外）
];

function inBox(lng: number, lat: number, box: Box) {
  return lng >= box.west && lng <= box.east && lat >= box.south && lat <= box.north;
}

/** 这个点在不在中国大陆（高德会加偏的范围）。 */
export function isInMainlandChina(lng: number, lat: number): boolean {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  if (!inBox(lng, lat, MAINLAND)) return false;
  return !EXCLUDED.some((box) => inBox(lng, lat, box));
}

/**
 * 标准的 WGS-84 → GCJ-02 变换。大陆以外的点原样返回。
 * 返回 [lng, lat]，和 MapLibre 的 LngLat 顺序一致。
 */
export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (!isInMainlandChina(lng, lat)) return [lng, lat];
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return [lng + dLng, lat + dLat];
}
