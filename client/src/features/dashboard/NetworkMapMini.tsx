import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import NetworkMapCanvas from "@/components/network/NetworkMapCanvas";
import "@/components/network/networkMap.css";
import { useTheme } from "@/contexts/ThemeContext";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { usePageVisible } from "@/hooks/usePageVisible";
import { groupCoverageBox, miniOpenHref, pickInsetGroups, placeInsets, unlocatedHostCount, type MiniLayoutReport } from "@/features/network/networkMapMini";
import type { NetworkMapModel } from "@/features/network/networkMapModel";
import { NETWORK_MAP_BASE_LAYERS, NETWORK_MAP_LAYER_STORAGE_KEY, resolveNetworkMapBaseLayer, type NetworkMapBaseLayerId } from "@shared/networkMapBaseLayers";
import { leaderBetweenBoxes } from "@shared/networkMapGeometry";

/**
 * 首页卡片里的真地图：/map 那台画布的 mini 模式，不能拖不能缩，点哪里都跳去整页。
 *
 * 这个文件由卡片 lazy() 引入 —— 它静态引用画布（连着 MapLibre 那几百 KB），首页的首屏
 * 包不该带上它；引擎没到之前卡片先画原来的 SVG 示意图。
 *
 * 主图上每台主机都画在真实坐标上，圆盘会压在一起的（港粤几台）并成一枚叠起来的 marker；
 * 最大的那组（桌面上最大的两组）在图上开一扇「局部放大」的小窗：第二个不能拖的 MapLibre，
 * 只框那几台，26px 的圆盘、名字、弧线、彗星都照画。小窗摆在主图最空的那个角（placeInsets），
 * 主图上用一个细虚线框圈出这组盖住的范围，再拉一根引线到小窗。摆哪由主图每次布局完报上来的
 * 占用情况决定（onMiniLayout），所以小窗永远不压主机、名字和胶囊。
 *
 * 底图跟 /map 一样：用户在整页选过的优先（同一个 localStorage 键），没选过就跟面板主题。
 * 高德瓦片拉不下来时悄悄切到暗黑网格（主图和小窗一起切）—— 首页上不弹提示，那是整页的事。
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
  const desktop = useMediaQuery("(min-width: 900px)");
  const pageVisible = usePageVisible();
  const [baseLayer, setBaseLayer] = useState<NetworkMapBaseLayerId>(() => resolveNetworkMapBaseLayer(readStoredLayer(), resolvedTheme));
  const [unavailable, setUnavailable] = useState(false);
  const [report, setReport] = useState<MiniLayoutReport | null>(null);
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
  const onMiniLayout = useCallback((next: MiniLayoutReport) => setReport(next), []);
  const unlocated = unlocatedHostCount(model);
  const paused = !pageVisible || !inView;

  // 哪几组开小窗、小窗摆哪、圈哪、引线怎么拉：都从主图报上来的布局算
  const insets = useMemo(() => {
    if (!report) return [];
    const groups = pickInsetGroups(report.groups, desktop);
    if (groups.length === 0) return [];
    const placements = placeInsets({ width: report.width, height: report.height }, { boxes: report.boxes, points: report.points }, groups.length, desktop);
    return placements.map((placement, index) => {
      const group = groups[index];
      const coverage = groupCoverageBox(group.members, group.markerBox);
      return { group, placement, coverage, leader: coverage ? leaderBetweenBoxes(coverage, placement.box) : null };
    });
  }, [report, desktop]);
  // 主图上的延迟胶囊要躲开小窗（小窗摆位不看胶囊，所以不会互相追着跑）
  const avoidBoxes = useMemo(() => insets.map((item) => item.placement.box), [insets]);

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
        paused={paused}
        comets
        onSelectNode={(id) => onOpen(miniOpenHref({ kind: "host", id }))}
        onSelectLink={(id) => onOpen(miniOpenHref({ kind: "link", id }))}
        onSelectTarget={() => onOpen(miniOpenHref(null))}
        onSelectCluster={(_center, _zoom, hostIds) => onOpen(miniOpenHref(hostIds.length > 0 ? { kind: "host", id: hostIds[0] } : null))}
        onMapClick={() => onOpen(miniOpenHref(null))}
        onRasterError={onRasterError}
        onUnavailable={() => setUnavailable(true)}
        onMiniLayout={onMiniLayout}
        avoidBoxes={avoidBoxes}
        onReady={() => {}}
      />
      {report && insets.length > 0 ? (
        <svg className="nm-inset-links" width={report.width} height={report.height} viewBox={`0 0 ${report.width} ${report.height}`} aria-hidden="true">
          {insets.map(({ group, coverage, leader }) => (
            <g key={group.hostIds.join(",")}>
              {coverage ? <rect x={coverage.x} y={coverage.y} width={coverage.w} height={coverage.h} rx={7} /> : null}
              {leader ? <line x1={leader[0].x} y1={leader[0].y} x2={leader[1].x} y2={leader[1].y} /> : null}
            </g>
          ))}
        </svg>
      ) : null}
      {insets.map(({ group, placement }) => {
        const first = group.hostIds[0];
        const open = () => onOpen(miniOpenHref({ kind: "host", id: first }));
        return (
          // 组员变了（key 变）就整扇窗重建：旧的 MapLibre 实例随之销毁
          <div key={group.hostIds.join(",")} className={`nm-inset${placement.shrunk ? " is-small" : ""}`} style={{ left: placement.box.x, top: placement.box.y, width: placement.box.w, height: placement.box.h }} aria-label={`局部放大：${group.label}，${group.hostIds.length} 台`}>
            <NetworkMapCanvas
              variant="inset"
              fitHostIds={group.hostIds}
              model={model}
              baseLayer={baseLayer}
              focus={null}
              showFlows={false}
              padding={NO_PADDING}
              reduceMotion={reduceMotion}
              paused={paused}
              comets
              onSelectNode={(id) => onOpen(miniOpenHref({ kind: "host", id }))}
              onSelectLink={(id) => onOpen(miniOpenHref({ kind: "link", id }))}
              onSelectTarget={open}
              onSelectCluster={open}
              onMapClick={open}
              onRasterError={onRasterError}
              onUnavailable={() => {}}
              onReady={() => {}}
            />
            <span className="nm-inset-title nm-reserved">{group.label} ×{group.hostIds.length}</span>
          </div>
        );
      })}
      {unlocated > 0 ? <span className="nm-mini-unlocated nm-reserved nm-num">{unlocated} 台未定位</span> : null}
    </div>
  );
}
