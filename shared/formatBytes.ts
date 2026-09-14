/**
 * 字节数 → 给人看的字符串。全站唯一一份。
 *
 * 之前有 **7 份各自定义、7 种不同实现**，同一个数在不同页面能显示成不同的样子：
 *
 *   - 系统设置和插件那两份**封顶到 MB** —— 5 GB 的备份写成「5120.0 MB」
 *   - 用户管理那份阶梯只到 TB，超过 1 PB 会取到数组外，显示成「1.78 undefined」
 *   - 转发规则那份保留尾零（「1.50 GB」），别处是「1.5 GB」
 *
 * 一个数在两个页面长得不一样，比显示得不好看严重得多 —— 人会开始不确定该信哪个。
 *
 * 用 1024 进制：这是「已经跑了多少」的口径，和机房/系统工具对得上。
 * 注意和 `shared/trafficGb.ts` 分工不同 —— 那个是**配额输入**的换算（人填「100GB」
 * 时按 1000 算），两者故意不一样，不要合并。
 */
const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
const STEP = 1024;

export function formatBytes(bytes: number | string | null | undefined): string {
  const num = Number(bytes);
  if (!Number.isFinite(num) || num === 0) return "0 B";
  const magnitude = Math.abs(num);
  // 夹住下标：越界会取到 undefined，界面上就会出现「1.78 undefined」。
  const index = Math.min(UNITS.length - 1, Math.max(0, Math.floor(Math.log(magnitude) / Math.log(STEP))));
  const value = num / STEP ** index;
  // 字节不带小数（「512 B」而不是「512.00 B」）；再大的单位留两位，
  // parseFloat 顺手把尾零去掉 —— 「1.5 GB」而不是「1.50 GB」。
  return `${parseFloat(value.toFixed(index === 0 ? 0 : 2))} ${UNITS[index]}`;
}

/**
 * 额度口径的字节显示：0 表示「不限」，不是「0 B」。
 *
 * 套餐商店、我的套餐、套餐管理三页原来各有一份叫 `bytes` 的私有实现 —— 那是
 * formatBytes 收敛之后**漏掉的第三种写法**：单位阶梯只到 TB，而且保留尾零
 * （「1.50 GB」），跟全站其它地方的「1.5 GB」对不上。现在数字部分交给
 * formatBytes，这里只负责「0 当成不限」这一条额度语义。
 */
export function formatQuotaBytes(size?: number | null, unlimitedText = "不限") {
  const value = Number(size || 0);
  if (!value) return unlimitedText;
  return formatBytes(value);
}
