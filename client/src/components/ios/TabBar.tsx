import { cn } from "@/lib/utils";
import { activeTabPath, type TabBarPlan } from "./tabBar";

/**
 * iOS 底部标签栏。
 *
 * ── 为什么要有它 ──
 *
 * 上一版手机端是「汉堡 → 抽屉」。抽屉的问题不是不好看，是**它把常用的和罕用的
 * 放在同一个深度**：去「转发规则」和去「支付对接」都是点汉堡、找一行、点一下。
 * 而实际使用里前者一天几十次，后者一个月一次。
 *
 * 标签栏把最常去的几个摊开在拇指够得到的地方，一步到位；罕用的收进「更多」，
 * 还是两步。总的点击次数下降，而且**你随时看得见自己在哪一格**。
 *
 * ── 为什么选中态是黑色不是蓝色 ──
 *
 * iOS 原版用系统蓝做 tint。这套面板的颜色已经全部让给状态语义（正常/降级/故障），
 * 再引入一个只是「选中」的蓝，会和「这条线路正常」的绿、「这条故障」的红在同一
 * 屏里抢注意力。所以选中态走黑白 —— 和分段控件的选中项是同一套。
 *
 * ── 毛玻璃 ──
 *
 * 标签栏是少数**应该**半透明的东西：内容从它底下滑过去时，那一点透出来的颜色
 * 告诉你「下面还有，能继续滚」。这是信息，不是装饰。
 */
export function IosTabBar({
  plan,
  currentPath,
  onNavigate,
  className,
}: {
  plan: TabBarPlan;
  currentPath: string;
  onNavigate: (path: string) => void;
  className?: string;
}) {
  if (!plan.tabs.length) return null;
  const active = activeTabPath(plan, currentPath);

  return (
    <nav aria-label="主导航" className={cn("fx-tabbar", className)}>
      {plan.tabs.map((tab) => {
        const selected = active === tab.path;
        return (
          <button
            key={tab.path}
            type="button"
            /*
              aria-current="page" 而不是只靠颜色：读屏用户和色觉障碍用户都要能
              知道自己在哪一格，而这两个 24px 的图标之间只差一个填充度。
            */
            aria-current={selected ? "page" : undefined}
            onClick={() => onNavigate(tab.path)}
            className={cn(
              "fx-tabbar-item",
              selected && "fx-tabbar-item-active",
            )}
          >
            <tab.icon
              className="h-6 w-6"
              strokeWidth={selected ? 2.2 : 1.7}
              aria-hidden="true"
            />
            <span className="fx-tabbar-label">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
