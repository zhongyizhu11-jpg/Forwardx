import { useEffect, useRef, type ReactNode } from "react";

import { clampSheetY, nextSheetSnap, sheetSnapY, type SheetSnap } from "@/features/network/networkMapPageState";

/**
 * 抽屉的壳：手机上是从底下升起的玻璃面板（收起 / 半屏 / 全屏三档，把手可拖），
 * ≥900px 时变成浮在图右边的一张玻璃卡（CSS 里把 transform 强制成 none，这里的拖动也不再响应）；
 * 桌面上没选中东西时这张卡收起来（open = false），地图铺满。
 *
 * 拖动直接改 DOM 的 transform，不走 React 状态：手指每动一像素都 setState 的话，
 * 抽屉里的图表跟着重画，手机上拖不动。松手时才算出该落到哪一档、通知页面。
 */
export type NetworkMapSheetProps = {
  snap: SheetSnap;
  onSnapChange: (snap: SheetSnap) => void;
  /** 桌面右侧浮卡模式 */
  rail: boolean;
  /** 桌面上这张卡开着没有（手机上抽屉一直在，只是档位不同） */
  open?: boolean;
  /** 抽屉所在容器的高度（算三档位置用） */
  containerHeight: number;
  reduceMotion: boolean;
  head: ReactNode;
  /** 变了就把正文滚回顶部（换视图时） */
  viewKey: string;
  children: ReactNode;
};

export function NetworkMapSheet({ snap, onSnapChange, rail, open = true, containerHeight, reduceMotion, head, viewKey, children }: NetworkMapSheetProps) {
  const sheetRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; startY: number; lastY: number; lastT: number; velocity: number; base: number } | null>(null);
  const latest = useRef({ snap, containerHeight, rail, reduceMotion, onSnapChange });
  latest.current = { snap, containerHeight, rail, reduceMotion, onSnapChange };

  // 档位 / 容器高度变了：动画到新位置（拖动中不动，松手那一下自己会算）
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet || rail || dragRef.current) return;
    sheet.style.transition = reduceMotion ? "none" : "transform .38s cubic-bezier(.2,.8,.2,1)";
    sheet.style.transform = `translateY(${sheetSnapY(snap, containerHeight)}px)`;
    // 抽屉是整个容器那么高、往下平移出去的：平移出去的那截在屏幕外。告诉 CSS 这截多高，
    // 正文底下留出这么多、「查看详情」贴在看得见的底边上，而不是贴在屏幕外的真底边上
    sheet.style.setProperty("--nm-sheet-hidden", `${sheetSnapY(snap, containerHeight)}px`);
  }, [snap, containerHeight, rail, reduceMotion]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [viewKey]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (latest.current.rail) return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, lastY: event.clientY, lastT: performance.now(), velocity: 0, base: sheetSnapY(latest.current.snap, latest.current.containerHeight) };
    sheet.style.transition = "none";
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const sheet = sheetRef.current;
    if (!drag || !sheet || drag.pointerId !== event.pointerId) return;
    const now = performance.now();
    const dt = Math.max(1, now - drag.lastT);
    drag.velocity = (event.clientY - drag.lastY) / dt;
    drag.lastY = event.clientY;
    drag.lastT = now;
    const y = clampSheetY(drag.base + (event.clientY - drag.startY), latest.current.containerHeight);
    sheet.style.transform = `translateY(${y}px)`;
  };
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    // 松手前停了一会儿再放开：速度按 0 算，否则最后一下的速度会把抽屉甩到别的档
    const velocity = performance.now() - drag.lastT > 80 ? 0 : drag.velocity;
    const next = nextSheetSnap({ current: latest.current.snap, startY: drag.startY, endY: event.clientY, velocity, containerHeight: latest.current.containerHeight });
    const sheet = sheetRef.current;
    if (sheet && !latest.current.rail) {
      sheet.style.transition = latest.current.reduceMotion ? "none" : "transform .38s cubic-bezier(.2,.8,.2,1)";
      sheet.style.transform = `translateY(${sheetSnapY(next, latest.current.containerHeight)}px)`;
      sheet.style.setProperty("--nm-sheet-hidden", `${sheetSnapY(next, latest.current.containerHeight)}px`);
    }
    latest.current.onSnapChange(next);
  };

  return (
    <section ref={sheetRef} className="nm-sheet" data-snap={snap} data-open={open ? "true" : "false"} aria-label="详情抽屉" aria-hidden={rail && !open ? true : undefined}>
      <div className="nm-sheet-grip" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
        <div className="nm-handle" aria-hidden="true" />
        {head}
      </div>
      <div ref={bodyRef} className="nm-sheet-body">{children}</div>
    </section>
  );
}
