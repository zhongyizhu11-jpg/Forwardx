import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import NetworkMapCanvas, { type NetworkMapCameraApi } from "@/components/network/NetworkMapCanvas";
import "@/components/network/networkMap.css";
import { useTheme } from "@/contexts/ThemeContext";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { usePageVisible } from "@/hooks/usePageVisible";
import { groupTipText, hostTipText, linkTipText, unlocatedHostCount } from "@/features/network/networkMapMini";
import { pickHubNode } from "@/features/network/networkMapLines";
import type { NetworkMapModel } from "@/features/network/networkMapModel";

import { NetworkMapMiniChrome } from "./NetworkMapMiniChrome";

/**
 * 首页卡片里的真地图：能拖、能捏合缩放、双击放大，角上有 + / −；点哪里都不跳 —— 点主机 / 线 / 组
 * 只在底部闪一句「是谁、什么状态」，点组的同时画布把这组的主机框进画面。
 *
 * 这个文件由卡片 lazy() 引入 —— 它静态引用画布（连着 MapLibre 那几百 KB），首页的首屏
 * 包不该带上它；引擎没到之前卡片先画原来的 SVG 示意图。
 *
 * 底图固定是夜晚的地球；图这块永远深色（.nm-surface），卡片的标题行跟面板主题。
 * 画布自己记着用户动没动过，动过就不再自动框，这里显示「回到全览」。
 */
/** 点一下的提示停多久 */
const TIP_MS = 2500;

export default function NetworkMapMini({ model, fallback }: {
  model: NetworkMapModel;
  /** 引擎起不来（没有 WebGL）时画这个：原来的示意图 */
  fallback: ReactNode;
}) {
  const { resolvedTheme } = useTheme();
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const pageVisible = usePageVisible();
  const [unavailable, setUnavailable] = useState(false);
  const [userMoved, setUserMoved] = useState(false);
  const [tip, setTip] = useState<string | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<NetworkMapCameraApi | null>(null);
  const tipTimer = useRef<number>(0);

  // 卡片滚出视野就停掉光点：首页往下翻到流量图时，看不见的地图不该还在每帧写数据
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver((entries) => setInView(entries.some((entry) => entry.isIntersecting)), { threshold: 0.05 });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => { if (tipTimer.current) window.clearTimeout(tipTimer.current); }, []);

  const onReady = useCallback((api: NetworkMapCameraApi) => { apiRef.current = api; }, []);
  const showTip = useCallback((text: string) => {
    setTip(text);
    if (tipTimer.current) window.clearTimeout(tipTimer.current);
    tipTimer.current = window.setTimeout(() => setTip(null), TIP_MS);
  }, []);
  const hub = useMemo(() => pickHubNode(model), [model]);

  const onSelectNode = useCallback((id: number) => {
    const node = model.nodes.find((item) => item.id === id);
    if (node) showTip(hostTipText(node));
  }, [model, showTip]);
  const onSelectLink = useCallback((id: number) => {
    const link = model.links.find((item) => item.id === id);
    if (link) showTip(linkTipText(link, model.nodes));
  }, [model, showTip]);
  const onSelectGroup = useCallback((hostIds: number[], label: string) => showTip(groupTipText(label, hostIds.length)), [showTip]);
  const onUnavailable = useCallback(() => setUnavailable(true), []);

  if (unavailable) return <>{fallback}</>;
  return (
    <div ref={frameRef} className="fx-netmap nm-mini nm-surface">
      <NetworkMapCanvas
        model={model}
        skin={resolvedTheme}
        reduceMotion={reduceMotion}
        paused={!pageVisible || !inView}
        hubHostId={hub}
        onSelectNode={onSelectNode}
        onSelectLink={onSelectLink}
        onSelectGroup={onSelectGroup}
        onUserMovedChange={setUserMoved}
        onUnavailable={onUnavailable}
        onReady={onReady}
      />
      <NetworkMapMiniChrome
        userMoved={userMoved}
        tip={tip}
        unlocated={unlocatedHostCount(model)}
        onZoom={(delta) => apiRef.current?.zoomBy(delta)}
        onReset={() => apiRef.current?.fitAll()}
      />
    </div>
  );
}
