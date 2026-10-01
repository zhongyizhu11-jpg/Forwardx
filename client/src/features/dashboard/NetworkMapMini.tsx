import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import NetworkMapCanvas, { type NetworkMapCameraApi } from "@/components/network/NetworkMapCanvas";
import "@/components/network/networkMap.css";
import { useTheme } from "@/contexts/ThemeContext";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { usePageVisible } from "@/hooks/usePageVisible";
import { hostTipText, linkTipText, unlocatedHostCount, type MiniLayoutReport } from "@/features/network/networkMapMini";
import { pickHubNode } from "@/features/network/networkMapLines";
import type { NetworkMapModel } from "@/features/network/networkMapModel";
import { browserLayerStorage, readNetworkMapBaseLayer, type NetworkMapBaseLayerId } from "@shared/networkMapBaseLayers";

import { NetworkMapMiniChrome } from "./NetworkMapMiniChrome";

/**
 * 首页卡片里的真地图：/map 那台画布的 mini 模式，能拖、能捏合缩放、双击放大，角上有 + / −；
 * 点哪里都不跳整页 —— 点主机 / 线 / 组只在底部闪一句「是谁、什么状态」，整页的入口只有卡片
 * 标题旁的「打开地图」。
 *
 * 这个文件由卡片 lazy() 引入 —— 它静态引用画布（连着 MapLibre 那几百 KB），首页的首屏
 * 包不该带上它；引擎没到之前卡片先画原来的 SVG 示意图。
 *
 * 主机都画在真实坐标上，圆盘会压在一起的（港粤几台）并成一枚带数量的 marker，点一下就放大到
 * 那一片，组里的主机自然散开、各自显示名字。不再开「局部放大」小窗：小窗、虚线框和引线叠在
 * 主图上，用户看不明白，宁可让人点一下放大。
 * 画布自己记着用户动没动过（userMoved），动过就不再自动框，这里显示「回到全览」。
 *
 * 底图跟 /map 一样：用户在整页选过的优先（同一个 localStorage 键，readNetworkMapBaseLayer），没选过就是标准地图（夜晚的地球）；
 * 图这块永远深色（.nm-surface），卡片的标题行跟面板主题。高德瓦片拉不下来时悄悄切回标准地图
 * （主图和小窗一起切）—— 首页上不弹提示，那是整页的事。
 */
const NO_PADDING = { top: 0, bottom: 0, left: 0, right: 0 };
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
  const [baseLayer, setBaseLayer] = useState<NetworkMapBaseLayerId>(() => readNetworkMapBaseLayer(browserLayerStorage()));
  const skin = resolvedTheme;
  const [unavailable, setUnavailable] = useState(false);
  /** 主图最近一次布局：「回到全览」看它 */
  const [report, setReport] = useState<MiniLayoutReport | null>(null);
  const [tip, setTip] = useState<string | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<NetworkMapCameraApi | null>(null);
  const tipTimer = useRef<number>(0);

  // 卡片滚出视野就停掉彗星：首页往下翻到流量图时，看不见的地图不该还在每帧写数据
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver((entries) => setInView(entries.some((entry) => entry.isIntersecting)), { threshold: 0.05 });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => { if (tipTimer.current) window.clearTimeout(tipTimer.current); }, []);

  const onRasterError = useCallback(() => setBaseLayer("night"), []);
  const onMiniLayout = useCallback((next: MiniLayoutReport) => setReport(next), []);
  const onReady = useCallback((api: NetworkMapCameraApi) => { apiRef.current = api; }, []);
  const showTip = useCallback((text: string) => {
    setTip(text);
    if (tipTimer.current) window.clearTimeout(tipTimer.current);
    tipTimer.current = window.setTimeout(() => setTip(null), TIP_MS);
  }, []);
  const unlocated = unlocatedHostCount(model);
  const hub = useMemo(() => pickHubNode(model), [model]);
  const paused = !pageVisible || !inView;

  // 点主机 / 线 / 组：只提示，不跳整页
  const onSelectNode = useCallback((id: number) => {
    const node = model.nodes.find((item) => item.id === id);
    if (node) showTip(hostTipText(node));
  }, [model, showTip]);
  const onSelectLink = useCallback((id: number) => {
    const link = model.links.find((item) => item.id === id);
    if (link) showTip(linkTipText(link, model.nodes));
  }, [model, showTip]);
  const noop = useCallback(() => {}, []);

  if (unavailable) return <>{fallback}</>;
  return (
    <div ref={frameRef} className="fx-netmap nm-map-wrap nm-mini nm-surface" data-skin={skin}>
      <NetworkMapCanvas
        variant="mini"
        model={model}
        baseLayer={baseLayer}
        skin={skin}
        focus={null}
        showFlows={false}
        padding={NO_PADDING}
        reduceMotion={reduceMotion}
        paused={paused}
        comets
        hubHostId={hub}
        onSelectNode={onSelectNode}
        onSelectLink={onSelectLink}
        onSelectTarget={noop}
        onSelectCluster={noop}
        onMapClick={noop}
        onRasterError={onRasterError}
        onUnavailable={() => setUnavailable(true)}
        onMiniLayout={onMiniLayout}
        onReady={onReady}
      />
      <NetworkMapMiniChrome
        userMoved={!!report?.userMoved}
        tip={tip}
        unlocated={unlocated}
        onZoom={(delta) => apiRef.current?.zoomBy(delta)}
        onReset={() => apiRef.current?.fitAll()}
      />
    </div>
  );
}
