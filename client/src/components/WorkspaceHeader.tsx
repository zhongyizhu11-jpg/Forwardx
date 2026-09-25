import type { ReactNode } from "react";

import { useIsMobile } from "@/hooks/useMobile";

/**
 * 页面的标题栏。
 *
 * 照参考站（New API / Vexo）的 SectionPageLayout：一行紧凑的粗标题，主操作排在同一行
 * 右侧；说明和状态是下面一行小灰字。桌面和手机是同一个形态，只差字号（令牌里按宽度改）。
 *
 * ── 为什么不再用 iOS 大标题导航栏 ──
 *
 * 上一版手机端是「26px 大标题、滚动时缩进顶栏」。那是在「手机上没有常驻顶栏」的前提
 * 下做的：页面名得自己撑起「我在哪」。现在外壳有一条 48px 的顶栏（品牌、搜索、账户），
 * 「我在哪」由底部标签栏的选中格说，页面标题就退回一行 —— 每一页顶上省下 60px，
 * 一屏多看一条规则。搜索也不再挂在标题旁边，它在顶栏上。
 */
export default function WorkspaceHeader({ title, description, status, actions, level = 1 }: {
  title: ReactNode; description?: ReactNode; status?: ReactNode; actions?: ReactNode; level?: 1 | 2;
}) {
  const isMobile = useIsMobile();
  const Heading = level === 1 ? "h1" : "h2";
  /*
    手机上状态那一行（「15 / 16 已启用」这类）比说明文字要紧：说明是给第一次来的人看的，
    状态是这一页此刻的概况。两个都有时手机只留状态，桌面两个都放。
  */
  const meta = isMobile && level === 1 ? (status ?? description) : null;

  return (
    <header className="workspace-header" data-level={level}>
      <div className="min-w-0">
        <Heading className="workspace-header-title">{title}</Heading>
        {isMobile && level === 1 ? (
          meta ? <div className="workspace-header-meta">{meta}</div> : null
        ) : (status || description) ? (
          <div className="workspace-header-meta">
            {status}
            {description && <p>{description}</p>}
          </div>
        ) : null}
      </div>
      {actions && <div className="workspace-header-actions">{actions}</div>}
    </header>
  );
}
