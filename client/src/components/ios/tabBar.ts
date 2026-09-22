import type { LucideIcon } from "lucide-react";

/**
 * 底部 Tab Bar 该放哪几项。
 *
 * iOS 的 Tab Bar 是「这是一个 app」的第一眼证据，也是它和网页最大的结构差别：
 * 网页用汉堡菜单把入口藏起来，app 把最常去的几个摊在手指够得到的地方。
 *
 * 规则只有三条，写成纯函数是因为它要按权限动态算 —— 管理员和租户看到的不是
 * 同一批页面，而「按身份写一堆 if」正是上一版导航的病根。
 *
 * 1. 按 `preferred` 给的顺序挑，挑到的才上 Tab，挑不到的（没权限/没开）跳过。
 * 2. 最多 `max` 格。iOS 的硬上限是 5，再多手指点不准。
 * 3. 装不下的全部收进最后一格「更多」—— 不是丢掉，是换个地方。
 *
 * 为什么不让调用方直接写死五个路径：一个只有转发权限的租户会拿到一个
 * 「主机」空 Tab，点进去是 403。挑选必须发生在过滤之后。
 */

export type TabDestination = {
  path: string;
  label: string;
  icon: LucideIcon;
};

export type TabBarPlan = {
  tabs: TabDestination[];
  /** 没上 Tab 的那些。「更多」页把它们列出来 */
  overflow: TabDestination[];
  /** 最后一格是不是「更多」 */
  hasMore: boolean;
};

export const MORE_TAB_PATH = "/more";

export function pickTabBarItems({
  destinations,
  preferred,
  shortLabels,
  more,
  max = 5,
}: {
  /** 已经按权限过滤过的全部目的地 */
  destinations: TabDestination[];
  /** 想上 Tab 的路径，按优先级排 */
  preferred: string[];
  /**
   * 标签栏专用的短名。
   *
   * 侧边栏写「转发规则」「主机管理」是对的 —— 那里有横向空间，而且要和
   * 「链路管理」区分开。标签栏一格只有 78px、字号 10px，四个汉字挤进去
   * 要么截断要么糊成一团。iOS 自己的标签也全是两个词以内。
   *
   * 只改标签栏这一处的显示，读屏和「更多」页仍然用全名。
   */
  shortLabels?: Record<string, string>;
  /** 「更多」那一格 */
  more: TabDestination;
  max?: number;
}): TabBarPlan {
  const byPath = new Map(destinations.map((item) => [item.path, item]));
  const picked: TabDestination[] = [];
  for (const path of preferred) {
    const item = byPath.get(path);
    if (!item || picked.some((p) => p.path === item.path)) continue;
    const short = shortLabels?.[item.path];
    picked.push(short ? { ...item, label: short } : item);
  }

  const overflowAll = destinations.filter(
    (item) => !picked.some((p) => p.path === item.path),
  );

  /*
    全部装得下就不要「更多」那一格 —— 一个点进去只有两项的「更多」比没有它更
    让人困惑：用户会以为自己漏掉了什么。
  */
  if (picked.length <= max && overflowAll.length === 0) {
    return { tabs: picked, overflow: [], hasMore: false };
  }

  const tabs = picked.slice(0, max - 1);
  const overflow = [...picked.slice(max - 1), ...overflowAll];
  return { tabs: [...tabs, more], overflow, hasMore: true };
}

/**
 * 当前这一页对应哪一格。
 *
 * 不在 Tab 上的页面（从「更多」点进去的、从列表点进详情的）要把「更多」那一格
 * 点亮 —— iOS 上层级再深，你也始终知道自己在哪个 Tab 里面。
 */
export function activeTabPath(
  plan: TabBarPlan,
  currentPath: string,
): string | null {
  if (plan.tabs.some((tab) => tab.path === currentPath)) return currentPath;
  if (plan.hasMore) return MORE_TAB_PATH;
  return null;
}
