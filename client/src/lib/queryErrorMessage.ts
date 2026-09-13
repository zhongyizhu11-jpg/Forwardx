/**
 * 读取失败时给人看的那句话。
 *
 * 页面上「暂无数据」和「没读到数据」是两件完全不同的事，可界面上很容易长得一样 ——
 * 一次请求失败，列表默认值是空数组，于是钱包显示「暂无支付流水」。刚付过钱的人
 * 看到这句会直接来找你。所以失败必须说自己失败了。
 *
 * 后端的报错原文对普通用户没意义（多半是英文或一串堆栈），但对排查有用，所以留一行、
 * 截短，不让它撑破卡片。
 */
export function queryErrorMessage(error: unknown, maxLength = 160): string {
  const raw = typeof error === "string"
    ? error
    : String((error as any)?.message || "");
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** 一眼能看懂的失败原因；认不出来的就不猜，交给原文。 */
export function queryErrorHint(error: unknown): string {
  const text = queryErrorMessage(error, 400).toLowerCase();
  if (!text) return "";
  if (text.includes("unauthorized") || text.includes("未登录") || text.includes("登录已过期")) {
    return "登录可能已经过期，刷新一下页面重新登录。";
  }
  if (text.includes("forbidden") || text.includes("无权")) {
    return "这个账号没有查看这部分数据的权限。";
  }
  if (text.includes("failed to fetch") || text.includes("networkerror") || text.includes("timeout") || text.includes("超时")) {
    return "面板没连上，检查一下网络或者面板是不是在重启。";
  }
  return "";
}
