/**
 * 等经纬地球图 → Web 墨卡托瓦片的拉伸数学。
 *
 * 地球图（4096 × 2048）横向按经度均分、纵向按纬度均分；MapLibre 的栅格瓦片是 Web 墨卡托，纵向按
 * 墨卡托 y 均分。横向两者一样，只需要切出这块瓦片对应的那一段经度；纵向要逐行换算：瓦片里的每一行
 * 像素先算它上下两条边落在哪个纬度，再换算回原图的行，把原图那一条（可能不到一行、也可能好几行）
 * 拉成瓦片里的一行。画布那边（components/network/earthTiles.ts）就照这张表一行一行 drawImage。
 *
 * 纯数学，在 node 里测。
 */

export type TextureRowSpan = { sy: number; sh: number };
export type TextureTilePlan = {
  /** 原图里这块瓦片的横向起点和宽度（像素） */
  sx: number;
  sw: number;
  /** 瓦片里第 r 行对应原图的哪一条（起点、高度，像素，可以是小数） */
  rows: TextureRowSpan[];
};

/** 墨卡托 y（0 = 北边 85.05°，1 = 南边 −85.05°）→ 纬度（度） */
export function mercatorYToLat(t: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * t))) * 180) / Math.PI;
}

/** 纬度 → 等经纬图里的行（像素，0 = 北极，srcHeight = 南极） */
export function latToSourceY(lat: number, srcHeight: number): number {
  return ((90 - lat) / 180) * srcHeight;
}

/**
 * 一块瓦片 (z, x, y) 要从原图哪里取像素。x 按世界宽度回绕（世界副本用的是同一套瓦片号），
 * y 超出范围的夹到边上。原图一行都不到时高度至少给 0.5 像素：drawImage 的源高度为 0 会什么都不画，
 * 高纬度那几行就成了黑缝。
 */
export function textureTilePlan(z: number, x: number, y: number, tileSize: number, srcWidth: number, srcHeight: number): TextureTilePlan {
  const n = 2 ** z;
  const xx = ((x % n) + n) % n;
  const yy = Math.max(0, Math.min(n - 1, y));
  const sw = srcWidth / n;
  const sx = xx * sw;
  const world = tileSize * n;
  const rows: TextureRowSpan[] = [];
  for (let row = 0; row < tileSize; row += 1) {
    const top = latToSourceY(mercatorYToLat((yy * tileSize + row) / world), srcHeight);
    const bottom = latToSourceY(mercatorYToLat((yy * tileSize + row + 1) / world), srcHeight);
    rows.push({ sy: top, sh: Math.max(0.5, bottom - top) });
  }
  return { sx, sw, rows };
}

/** 解析 `fxearth://night/3/5/2` 这种瓦片地址；不认得返回 null */
export function parseTextureTileUrl(url: string): { texture: string; z: number; x: number; y: number } | null {
  const match = /^[a-z]+:\/\/([a-z]+)\/(\d+)\/(-?\d+)\/(-?\d+)$/.exec(url);
  if (!match) return null;
  return { texture: match[1], z: Number(match[2]), x: Number(match[3]), y: Number(match[4]) };
}

/**
 * 夜光图的调色，逐像素、原地改（RGBA）。
 *
 * three-globe 带的那张夜光图：城市灯光是偏灰的白（东京一带约 92,93,92），海是蓝（1,19,40），没灯的陆地
 * 也偏蓝（撒哈拉 13,58,81）。缩小看时灯光被周围稀释，整张图发蓝、灯几乎看不见。灯和别的分得开靠红通道 ——
 * 海和陆地几乎没有红，灯有。所以：
 *   底色整体压暗（红绿五成、蓝留得多一点）—— 深海军蓝，陆地比海略亮一点点
 *   按红通道的亮度往上加一层橙黄的光 —— 灰白的灯变成暖色的城市灯光
 * 纯黑还是纯黑。
 */
export function gradeNightPixels(data: Uint8ClampedArray): void {
  for (let index = 0; index < data.length; index += 4) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const light = r > 6 ? (r - 6) * 1.2 : 0;
    data[index] = r * 0.5 + light * 1.6;
    data[index + 1] = g * 0.5 + light * 1.05;
    data[index + 2] = b * 0.62 + light * 0.32;
  }
}
