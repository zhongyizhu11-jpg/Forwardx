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
