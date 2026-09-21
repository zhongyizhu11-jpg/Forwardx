import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * 手机上顶栏已经写着当前页面的名字，所以这里的 H1 再写一遍就是白占地方 ——
 * 实测 390×844 的屏幕上，标题块连同主操作按钮要吃掉 150px，一屏本来也就
 * 放得下一条半规则。
 *
 * 所以手机上：H1 只留给读屏（文档大纲和「跳到主要内容」都还指得到它），
 * 主操作传送到顶栏那一行，status 压成一行细字跟在内容最前面。
 * 桌面端宽度够，保持原样。
 */
function TopbarActions({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    // 顶栏和页面是同一次提交渲染的，首帧拿不到挂载点，下一帧再取一次。
    const find = () => setSlot(document.getElementById("workspace-topbar-actions"));
    find();
    const raf = requestAnimationFrame(find);
    return () => cancelAnimationFrame(raf);
  }, []);
  if (!slot) return null;
  return createPortal(children, slot);
}

export default function WorkspaceHeader({ title, description, status, actions, level = 1 }: {
  title: ReactNode; description?: ReactNode; status?: ReactNode; actions?: ReactNode; level?: 1 | 2;
}) {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <>
      {actions && <TopbarActions>{actions}</TopbarActions>}
      <header className="workspace-header">
        <div className="min-w-0">
          <Heading className="workspace-header-title">{title}</Heading>
          {(status || description) && <div className="workspace-header-meta">
            {status}
            {description && <p className={status ? "hidden sm:block" : undefined}>{description}</p>}
          </div>}
        </div>
        {actions && <div className="workspace-header-actions">{actions}</div>}
      </header>
    </>
  );
}
