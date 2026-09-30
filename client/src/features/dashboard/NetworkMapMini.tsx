import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import NetworkMapCanvas from "@/components/network/NetworkMapCanvas";
import "@/components/network/networkMap.css";
import { useTheme } from "@/contexts/ThemeContext";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { usePageVisible } from "@/hooks/usePageVisible";
import { miniOpenHref, unlocatedHostCount } from "@/features/network/networkMapMini";
import type { NetworkMapModel } from "@/features/network/networkMapModel";
import { NETWORK_MAP_BASE_LAYERS, NETWORK_MAP_LAYER_STORAGE_KEY, resolveNetworkMapBaseLayer, type NetworkMapBaseLayerId } from "@shared/networkMapBaseLayers";

/**
 * 首页卡片里的真地图：/map 那台画布的 mini 模式，不能拖不能缩，点哪里都跳去整页。
 *
 * 这个文件由卡片 lazy() 引入 —— 它静态引用画布（连着 MapLibre 那几百 KB），首页的首屏
 * 包不该带上它；引擎没到之前卡片先画原来的 SVG 示意图。
 *
 * 底图跟 /map 一样：用户在整页选过的优先（同一个 localStorage 键），没选过就跟面板主题。
 * 高德瓦片拉不下来时悄悄切到暗黑网格 —— 首页上不弹提示，那是整页的事。
 */
const NO_PADDING = { top: 0, bottom: 0, left: 0, right: 0 };

function readStoredLayer(): unknown {
  try { return window.localStorage.getItem(NETWORK_MAP_LAYER_STORAGE_KEY); } catch { return null; }
}

export default function NetworkMapMini({ model, onOpen, fallback }: {
  model: NetworkMapModel;
  onOpen: (href: string) => void;
  /** 引擎起不来（没有 WebGL）时画这个：原来的示意图 */
  fallback: ReactNode;
}) {
  const { resolvedTheme } = useTheme();
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const pageVisible = usePageVisible();
  const [baseLayer, setBaseLayer] = useState<NetworkMapBaseLayerId>(() => resolveNetworkMapBaseLayer(readStoredLayer(), resolvedTheme));
  const [unavailable, setUnavailable] = useState(false);
  const frameRef = useRef<HTMLDivElement | null>(null);

  // 卡片滚出视野就停掉彗星：首页往下翻到流量图时，看不见的地图不该还在每帧写数据
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver((entries) => setInView(entries.some((entry) => entry.isIntersecting)), { threshold: 0.05 });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const onRasterError = useCallback(() => setBaseLayer("dark"), []);
  const unlocated = unlocatedHostCount(model);

  if (unavailable) return <>{fallback}</>;
  return (
    <div ref={frameRef} className="fx-netmap nm-map-wrap nm-mini" data-skin={NETWORK_MAP_BASE_LAYERS[baseLayer].skin}>
      <NetworkMapCanvas
        variant="mini"
        model={model}
        baseLayer={baseLayer}
        focus={null}
        showFlows={false}
        padding={NO_PADDING}
        reduceMotion={reduceMotion}
        paused={!pageVisible || !inView}
        comets
        onSelectNode={(id) => onOpen(miniOpenHref({ kind: "host", id }))}
        onSelectLink={(id) => onOpen(miniOpenHref({ kind: "link", id }))}
        onSelectTarget={() => onOpen(miniOpenHref(null))}
        onSelectCluster={() => onOpen(miniOpenHref(null))}
        onMapClick={() => onOpen(miniOpenHref(null))}
        onRasterError={onRasterError}
        onUnavailable={() => setUnavailable(true)}
        onReady={() => {}}
      />
      {unlocated > 0 ? <span className="nm-mini-unlocated nm-num">{unlocated} 台未定位</span> : null}
    </div>
  );
}
