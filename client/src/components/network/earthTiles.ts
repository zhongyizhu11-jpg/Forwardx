import maplibregl from "maplibre-gl";

import { NETWORK_MAP_NIGHT_TEXTURE_URL, NETWORK_MAP_TEXTURE_PROTOCOL, gradeNightPixels, nightLightGain, parseTextureTileUrl, textureTilePlan } from "@shared/networkMapTexture";

/**
 * 夜光地球图的瓦片：`fxearth://night/{z}/{x}/{y}`。
 *
 * 地球图是等经纬投影，MapLibre 要 Web 墨卡托。不在构建时预先拉伸（仓库里没有纯 JS 的 JPEG
 * 编解码器，为一张图加依赖不值），也不在运行时把整张图拉成一张大画布当图片源（图片源不跟着
 * 世界副本平铺，往东拖过日期变更线就是一片黑）—— 而是注册一个自定义协议，MapLibre 要哪块瓦片就
 * 现拉伸哪块：从原图里按 shared/networkMapTexture 的行表一行一行画进 256² 的小画布，调色后直接交回
 * ImageBitmap（不再编 JPEG 再让 MapLibre 解一遍）。只画看得见的那几块，世界副本照常平铺；原图整页只下载、
 * 解码一次。
 *
 * 画好的瓦片按 z/x/y 记着（x 先回绕：世界副本要的是同一块）：拖回来、缩回来、左右两份世界都不再重画。
 * 调色是按级别给的增益（nightLightGain）在缩小后的像素上做的，不能预先对整张图调一次 —— 那样远看时
 * 灯光的亮度会变，所以仍是一块一块调，只是每块只调一次。
 *
 * 协议是 MapLibre 全局的，注册一次就行；这个文件跟着画布一起 lazy 进来，首屏包不带。
 */

const TILE = 256;
/** 记多少块：一块 256² 的位图约 256 KB，64 块 16 MB 封顶；首页这张小图一屏只要十来块 */
const TILE_CACHE_MAX = 64;

let texture: Promise<HTMLImageElement> | null = null;
let registered = false;
/** z/x/y → 画好的瓦片（Map 保持插入顺序：命中时挪到最后，满了从最前面丢 —— 简单的 LRU） */
const tileCache = new Map<string, Promise<ImageBitmap | ArrayBuffer>>();

function loadTexture(): Promise<HTMLImageElement> {
  if (!texture) {
    const promise = new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`地球图 ${NETWORK_MAP_NIGHT_TEXTURE_URL} 没能加载`));
      image.src = NETWORK_MAP_NIGHT_TEXTURE_URL;
    });
    // 失败了不留着：下一块瓦片再拉一次
    promise.catch(() => { if (texture === promise) texture = null; });
    texture = promise;
  }
  return texture;
}

async function renderTile(z: number, x: number, y: number): Promise<ImageBitmap | ArrayBuffer> {
  const image = await loadTexture();
  const canvas = document.createElement("canvas");
  canvas.width = TILE;
  canvas.height = TILE;
  // 画完马上要读回像素调色：willReadFrequently 让它留在 CPU 上，免得每块都从 GPU 往回拷
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("画不了地球瓦片");
  context.imageSmoothingQuality = "high";
  const plan = textureTilePlan(z, x, y, TILE, image.naturalWidth, image.naturalHeight);
  for (let row = 0; row < plan.rows.length; row += 1) {
    const span = plan.rows[row];
    context.drawImage(image, plan.sx, span.sy, plan.sw, span.sh, 0, row, TILE, 1);
  }
  // 夜光图调色（gradeNightPixels）：灯光提亮偏暖，蓝色的海和没灯的陆地压暗 —— 缩小看时城市灯光不被周围稀释掉
  const pixels = context.getImageData(0, 0, TILE, TILE);
  gradeNightPixels(pixels.data, nightLightGain(z));
  // MapLibre 的协议直接收 ImageBitmap；老浏览器没有 createImageBitmap 才退回编 JPEG
  if (typeof createImageBitmap === "function") return createImageBitmap(pixels);
  context.putImageData(pixels, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  if (!blob) throw new Error("地球瓦片编码失败");
  return blob.arrayBuffer();
}

function tile(url: string): Promise<ImageBitmap | ArrayBuffer> {
  const parsed = parseTextureTileUrl(url);
  if (!parsed || parsed.texture !== "night") return Promise.reject(new Error(`认不出的地球瓦片 ${url}`));
  const n = 2 ** parsed.z;
  const x = ((parsed.x % n) + n) % n;
  const key = `${parsed.z}/${x}/${parsed.y}`;
  const hit = tileCache.get(key);
  if (hit) {
    tileCache.delete(key);
    tileCache.set(key, hit);
    return hit;
  }
  const promise = renderTile(parsed.z, x, parsed.y);
  // 画失败了不记：下次再画（ArrayBuffer 会被 MapLibre 转给 worker 拿走，也不记，每次交一份新的）
  const forget = () => { if (tileCache.get(key) === promise) tileCache.delete(key); };
  promise.then((data) => { if (data instanceof ArrayBuffer) forget(); }, forget);
  tileCache.set(key, promise);
  while (tileCache.size > TILE_CACHE_MAX) {
    const oldest = tileCache.keys().next().value as string;
    tileCache.delete(oldest);
  }
  return promise;
}

export function registerEarthTiles() {
  if (registered) return;
  registered = true;
  maplibregl.addProtocol(NETWORK_MAP_TEXTURE_PROTOCOL, async (params) => ({ data: await tile(params.url) }));
}
