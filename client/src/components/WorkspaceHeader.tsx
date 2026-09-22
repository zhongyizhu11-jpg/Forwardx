import type { ReactNode } from "react";
import { Search } from "lucide-react";

import { IosNavigationBar } from "@/components/ios/NavigationBar";
import { useMobileNav } from "@/components/ios/navigationContext";
import { useIsMobile } from "@/hooks/useMobile";

/**
 * 页面的标题栏。
 *
 * 桌面和手机是两种形态，不是同一个东西缩一缩：
 *
 * - **桌面**：标题、说明、主操作排成一行，跟着内容一起滚。侧边栏一直在，
 *   所以「我在哪」这件事不需要标题独自承担。
 * - **手机**：iOS 的大标题导航栏 —— 停在顶部时是 30px 大标题，滚起来收进
 *   44px 的顶栏变成小标题，同时浮出一条分隔线。
 *
 * ── 为什么手机上要换形态 ──
 *
 * 上一版手机端是「常驻顶栏写页面名 + 页面里的 H1 只给读屏」。那是在
 * 「必须有一条常驻顶栏」的前提下做的折中：同一个词在顶栏和正文各写一遍，
 * 白占 150px，所以只能留一份。
 *
 * 现在前提没了（顶栏删了，导航交给底部标签栏），标题可以回到页面里，而且
 * 可以用 iOS 那个更好的答案：**让标题自己让位**。打开时它大而显眼，滚动之后
 * 缩回顶栏那一行继续钉在那儿 —— 两个状态之间是同一个标题在移动，不会有
 * 「标题消失了」的断裂感。
 *
 * 主操作跟着大标题走，不再传送到别处；搜索是全局功能，所以放在导航栏右侧
 * 固定的那一格。
 */
export default function WorkspaceHeader({ title, description, status, actions, level = 1 }: {
  title: ReactNode; description?: ReactNode; status?: ReactNode; actions?: ReactNode; level?: 1 | 2;
}) {
  const isMobile = useIsMobile();
  const nav = useMobileNav();
  const Heading = level === 1 ? "h1" : "h2";

  /*
    level 2 是页面内部的次级标题，不是页面本身的名字 —— 它不该变成一条 sticky
    的导航栏（一页里出现两条导航栏，滚动时会互相叠住）。
  */
  if (isMobile && level === 1) {
    return (
      <IosNavigationBar
        title={title}
        /*
          状态那一行（「15 / 16 已启用」这类）当副标题跟着大标题一起收走 ——
          它是这一页此刻的概况，不是页面名，折叠之后没必要一直钉在顶栏。
          没有状态就退到说明文字，两个都没有就不画这一行。
        */
        subtitle={status ?? description}
        trailing={
          <>
            {actions}
            {nav ? (
              <button
                type="button"
                onClick={nav.onOpenSearch}
                aria-label="查找功能"
                className="flex h-9 w-9 items-center justify-center rounded-[var(--fx-radius-control)] text-[var(--fx-text)]"
              >
                <Search className="h-[18px] w-[18px]" aria-hidden="true" />
              </button>
            ) : null}
          </>
        }
      />
    );
  }

  return (
    <header className="workspace-header">
      <div className="min-w-0">
        <Heading className="workspace-header-title">{title}</Heading>
        {(status || description) && <div className="workspace-header-meta">
          {status}
          {description && <p>{description}</p>}
        </div>}
      </div>
      {actions && <div className="workspace-header-actions">{actions}</div>}
    </header>
  );
}
