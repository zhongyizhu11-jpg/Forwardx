import maplibregl from "maplibre-gl";

import { NETWORK_MAP_NIGHT_TEXTURE_URL, NETWORK_MAP_TEXTURE_PROTOCOL, gradeNightPixels, nightLightGain, parseTextureTileUrl, textureTilePlan } from "@shared/networkMapTexture";

/**
 * 夜光地球图的瓦片：`fxearth://night/{z}/{x}/{y}`。
 *
 * 地球图是等经纬投影，MapLibre 要 Web 墨卡托。不在构建时预先拉伸（仓库里没有纯 JS 的 JPEG
 * 编解码器，为一张图加依赖不值），也不在运行时把整张图拉成一张 4096² 的画布当图片源（图片源不跟着
 * 世界副本平铺，往东拖过日期变更线就是一片黑）—— 而是注册一个自定义协议，MapLibre 要哪块瓦片就
 * 现拉伸哪块：从原图里按 shared/networkMapTexture 的行表一行一行画进 256² 的小画布，编成 JPEG 交回去。
 * 只画看得见的那几块，世界副本照常平铺；原图整页只下载、解码一次。
 *
 * 协议是 MapLibre 全局的，注册一次就行；这个文件跟着画布一起 lazy 进来，首屏包不带。
 */

const TILE = 256;
let texture: Promise<HTMLImageElement> | null = null;
let registered = false;

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

async function renderTile(url: string): Promise<ArrayBuffer> {
  const parsed = parseTextureTileUrl(url);
  if (!parsed || parsed.texture !== "night") throw new Error(`认不出的地球瓦片 ${url}`);
  const image = await loadTexture();
  const canvas = document.createElement("canvas");
  canvas.width = TILE;
  canvas.height = TILE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("画不了地球瓦片");
  context.imageSmoothingQuality = "high";
  const plan = textureTilePlan(parsed.z, parsed.x, parsed.y, TILE, image.naturalWidth, image.naturalHeight);
  for (let row = 0; row < plan.rows.length; row += 1) {
    const span = plan.rows[row];
    context.drawImage(image, plan.sx, span.sy, plan.sw, span.sh, 0, row, TILE, 1);
  }
  // 夜光图调色（gradeNightPixels）：灯光提亮偏暖，蓝色的海和没灯的陆地压暗 —— 缩小看时城市灯光不被周围稀释掉
  const pixels = context.getImageData(0, 0, TILE, TILE);
  gradeNightPixels(pixels.data, nightLightGain(parsed.z));
  context.putImageData(pixels, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  if (!blob) throw new Error("地球瓦片编码失败");
  return blob.arrayBuffer();
}

export function registerEarthTiles() {
  if (registered) return;
  registered = true;
  maplibregl.addProtocol(NETWORK_MAP_TEXTURE_PROTOCOL, async (params) => ({ data: await renderTile(params.url) }));
}
