/*
  只给 avataaars 用的 lodash 替身（vite.config.ts 里的 avataaarsLodashShim 插件把
  它发出的 require("lodash") 换到这里）。

  avataaars 的 66 个文件一共 253 处 lodash 调用，全是 uniqueId —— 给每个 SVG
  渐变、遮罩生成不重复的 id。为这一个函数拖上整个 lodash 不值：换掉之后头像
  那一包从 528 kB 降到 455 kB（gzip 150 → 122 kB）。
  行为照抄 lodash：前缀 + 全局自增的数字，从 1 开始。
*/
let idCounter = 0;

export function uniqueId(prefix?: string) {
  idCounter += 1;
  return `${prefix ?? ""}${idCounter}`;
}
