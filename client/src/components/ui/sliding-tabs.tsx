import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export type SlidingTabItem<T extends string = string> = {
  value: T; label: string;
  icon?: ComponentType<{ className?: string }>;
  badge?: ReactNode; disabled?: boolean;
};
type SlidingTabsListProps<T extends string> = {
  items: readonly SlidingTabItem<T>[]; activeValue: T; ariaLabel?: string;
  className?: string; listClassName?: string; triggerClassName?: string;
  iconClassName?: string; badgeClassName?: string;
  /** Retained for callers; tabs now size to their labels. */
  minItemWidthRem?: number;
};

function revealActiveTab(element: HTMLDivElement) {
  if (element.scrollWidth <= element.clientWidth) return;
  const selected = element.querySelector<HTMLElement>('[data-state="active"]');
  if (!selected) return;
  const item = selected.getBoundingClientRect();
  const frame = element.getBoundingClientRect();
  // Leave room for the 44px touch scroll controls without moving the page.
  if (item.left < frame.left + 44) element.scrollLeft -= frame.left + 44 - item.left;
  else if (item.right > frame.right - 44) element.scrollLeft += item.right - frame.right + 44;
}
export function SlidingTabsList<T extends string>({
  items, activeValue, ariaLabel, className, listClassName,
  triggerClassName, iconClassName, badgeClassName,
}: SlidingTabsListProps<T>) {
  const viewport = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    // 滚动时每个 scroll 事件都会进来；两端状态没变就别换新对象，免得整条分类条跟着重渲染
    const measure = () => {
      const left = element.scrollLeft > 2;
      const right = element.scrollLeft + element.clientWidth < element.scrollWidth - 2;
      setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    const observer = new ResizeObserver(() => { revealActiveTab(element); measure(); });
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    element.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => { observer.disconnect(); element.removeEventListener("scroll", measure); };
  }, []);
  useEffect(() => {
    const element = viewport.current;
    if (element) revealActiveTab(element);
  }, [activeValue]);
  const scroll = (direction: number) => {
    const element = viewport.current;
    if (element) element.scrollBy({ left: direction * element.clientWidth * 0.7, behavior: "instant" });
  };
  return (
    <div
      className={cn("workspace-tabs relative min-w-0", className)}
      // 触屏上不画箭头，靠这两个属性把还有内容的那一边淡出去（workspace.css）
      data-more-left={edges.left ? "" : undefined}
      data-more-right={edges.right ? "" : undefined}
    >
      <div ref={viewport} className="workspace-tabs-viewport">
        <TabsList aria-label={ariaLabel} className={cn("workspace-tabs-list", listClassName)}>
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <TabsTrigger key={item.value} value={item.value} disabled={item.disabled}
                data-active={item.value === activeValue ? "true" : undefined}
                className={cn("workspace-tab group", triggerClassName)}>
                {Icon && <Icon className={cn("h-4 w-4 shrink-0", iconClassName)} />}
                {item.label}
                {item.badge !== undefined && item.badge !== null && (
                  <span className={cn("workspace-tab-count", badgeClassName)}>{item.badge}</span>
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </div>
      {edges.left && <button type="button" className="workspace-tab-scroll left-0" aria-label="查看前面的分类" onClick={() => scroll(-1)}><ChevronLeft className="h-4 w-4" /></button>}
      {edges.right && <button type="button" className="workspace-tab-scroll right-0" aria-label="查看更多分类" onClick={() => scroll(1)}><ChevronRight className="h-4 w-4" /></button>}
    </div>
  );
}
