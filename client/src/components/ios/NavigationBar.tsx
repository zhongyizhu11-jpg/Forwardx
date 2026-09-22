import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * iOS 大标题导航栏。
 *
 * ── 它解决的问题 ──
 *
 * 顶栏要同时干两件互相矛盾的事：页面刚打开时告诉你「这是哪一页」，滚起来之后
 * 让位给内容。网页的做法通常是二选一 —— 要么标题一直占着（手机上实测 150px
 * 的标题块，一屏本来也就放得下一条半规则），要么干脆不写标题、滚到一半就不
 * 知道自己在哪。
 *
 * iOS 的解法是**让标题自己让位**：停在顶部时是 34px 的大标题，滚动之后缩回
 * 顶栏那一行变成 17px，同时顶栏浮出一条分隔线。两个状态之间是同一个标题在
 * 移动，所以不会有「标题消失了」的断裂感。
 *
 * ── 实现上的一个坑 ──
 *
 * 这里故意**不用** IntersectionObserver 去观察大标题：大标题在折叠后高度归零，
 * 观察一个 0 高度的元素会在阈值边界上反复触发，表现是标题抖动。改成读滚动距离
 * 加一段迟滞（展开 8px / 折叠 16px），越过才翻转，中间那 8px 是缓冲区。
 */
export function IosNavigationBar({
  title,
  backLabel,
  onBack,
  trailing,
  /** 大标题下面那行小字。折叠时一起收走 */
  subtitle,
  /** 搜索框之类跟着大标题一起滚的东西 */
  belowTitle,
  className,
}: {
  title: ReactNode;
  /** 有返回目标才画返回键。iOS 上返回键带上一页的名字，不是光秃秃一个箭头 */
  backLabel?: string;
  onBack?: () => void;
  trailing?: ReactNode;
  subtitle?: ReactNode;
  belowTitle?: ReactNode;
  className?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const collapsedRef = useRef(false);

  useEffect(() => {
    const read = () => {
      const y = window.scrollY;
      /*
        迟滞：已展开要超过 16px 才折，已折叠要回到 8px 以内才展开。
        单阈值在临界点上会被惯性滚动来回穿过，表现就是标题抽搐。
      */
      const next = collapsedRef.current ? y > 8 : y > 16;
      if (next !== collapsedRef.current) {
        collapsedRef.current = next;
        setCollapsed(next);
      }
    };
    read();
    window.addEventListener("scroll", read, { passive: true });
    return () => window.removeEventListener("scroll", read);
  }, []);

  return (
    <header
      className={cn("fx-navbar", collapsed && "fx-navbar-collapsed", className)}
      data-collapsed={collapsed ? "true" : "false"}
    >
      <div className="fx-navbar-compact">
        {onBack ? (
          <button type="button" onClick={onBack} className="fx-navbar-back">
            <ChevronLeft className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span className="truncate">{backLabel || "返回"}</span>
          </button>
        ) : (
          <span className="fx-navbar-leading-spacer" aria-hidden="true" />
        )}
        {/*
          折叠后才显示的小标题。它和下面的大标题是同一段文字，所以用 aria-hidden
          挡住这一份，读屏只会听到一次。
        */}
        <span className="fx-navbar-inline-title" aria-hidden="true">
          {title}
        </span>
        <div className="fx-navbar-trailing">{trailing}</div>
      </div>
      <div className="fx-navbar-large">
        <h1 className="fx-navbar-large-title">{title}</h1>
        {/*
          这里必须是 div 不能是 p：页面传进来的 status 常常是一个 Badge，
          而 Badge 渲染出来是 div —— <p> 里放 <div> 是非法嵌套，浏览器会
          就地把 <p> 闭掉，实际渲染结构和写的不是一回事（控制台也会报
          「cannot be a descendant of <p>」）。
        */}
        {subtitle ? <div className="fx-navbar-subtitle">{subtitle}</div> : null}
      </div>
      {belowTitle ? <div className="fx-navbar-below">{belowTitle}</div> : null}
    </header>
  );
}
