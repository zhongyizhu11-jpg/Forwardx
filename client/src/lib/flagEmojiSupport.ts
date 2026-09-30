import { countryCodeToEmoji } from "./linkTestNodeMeta";

/**
 * 这台设备画不画得出某个国旗 emoji。
 *
 * 为什么要测：iOS 在中国大陆地区的机器上没有 🇹🇼 这面旗，会画成一个带叉的方框；
 * 老安卓、部分 Linux 字体也缺一些旗。地图上簇的药丸、主机圆盘都靠国旗认地方，
 * 画不出来就退回两个字母的国家代码，至少还看得懂。
 *
 * 判断方法：把 emoji 画到 canvas 上，数有没有带颜色（饱和度够高）的像素。真旗子
 * 总有红蓝绿之类的色块；缺字的方框是黑灰线条，一个彩色像素都没有。结果按 emoji
 * 缓存，一个页面里每面旗只画一次。
 */
const cache = new Map<string, boolean>();

export function flagEmojiRenders(flag: string): boolean {
  if (!flag) return false;
  if (typeof document === "undefined") return true;
  const cached = cache.get(flag);
  if (cached !== undefined) return cached;
  let renders = true;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      ctx.textBaseline = "top";
      ctx.font = "24px sans-serif";
      ctx.fillText(flag, 2, 2);
      const data = ctx.getImageData(0, 0, 32, 32).data;
      let colored = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 40) continue;
        const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
        if (Math.max(r, g, b) - Math.min(r, g, b) > 40) colored += 1;
      }
      renders = colored > 4;
    }
  } catch {
    // canvas 被禁（隐私模式、无头环境）：按能画处理，最多显示成方框，不比现在差
    renders = true;
  }
  cache.set(flag, renders);
  return renders;
}

/** 国家代码 → 国旗 emoji；这台设备画不出来时退回大写的两字母代码（如 TW）。 */
export function countryFlagLabel(countryCode: unknown): string {
  const emoji = countryCodeToEmoji(countryCode);
  if (!emoji) return "";
  if (flagEmojiRenders(emoji)) return emoji;
  return String(countryCode ?? "").trim().toUpperCase();
}

/** 是不是退回来的两字母代码（用来换成小字样式，别按 emoji 的大字号画）。 */
export function isCountryCodeLabel(label: unknown): boolean {
  return /^[A-Z]{2}$/.test(String(label ?? ""));
}

/** 测试用：清掉缓存。 */
export function resetFlagEmojiCache() {
  cache.clear();
}
