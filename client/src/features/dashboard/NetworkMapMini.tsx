import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import NetworkMapCanvas, { type NetworkMapCameraApi } from "@/components/network/NetworkMapCanvas";
import "@/components/network/networkMap.css";
import { useTheme } from "@/contexts/ThemeContext";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { usePageVisible } from "@/hooks/usePageVisible";
import { groupCoverageBox, groupPlaceLabel, groupTipText, hostTipText, insetLeader, linkTipText, matchInsetGroup, nextInsetGrowStage, pickInsetSlots, placeInsets, unlocatedHostCount, type InsetGrowStage, type InsetLayoutReport, type InsetPlacement, type MiniLayoutReport } from "@/features/network/networkMapMini";
import type { NetworkMapModel } from "@/features/network/networkMapModel";
import { NETWORK_MAP_BASE_LAYERS, NETWORK_MAP_LAYER_STORAGE_KEY, resolveNetworkMapBaseLayer, type NetworkMapBaseLayerId } from "@shared/networkMapBaseLayers";

import { NetworkMapMiniChrome } from "./NetworkMapMiniChrome";

/**
 * 首页卡片里的真地图：/map 那台画布的 mini 模式，能拖、能捏合缩放、双击放大，角上有 + / −；
 * 点哪里都不跳整页 —— 点主机 / 线 / 组只在底部闪一句「是谁、什么状态」，整页的入口只有卡片
 * 标题旁的「打开地图」。
 *
 * 这个文件由卡片 lazy() 引入 —— 它静态引用画布（连着 MapLibre 那几百 KB），首页的首屏
 * 包不该带上它；引擎没到之前卡片先画原来的 SVG 示意图。
 *
 * 主图上每台主机都画在真实坐标上，圆盘会压在一起的（港粤几台）并成一枚叠起来的 marker；
 * 最大的那组（桌面上最大的两组）在图上开一扇「局部放大」的小窗：第二个不能拖的 MapLibre，
 * 只框那组里真正挤在一起的那几台（pill 顺带吸进来的远一点的东京 / 台北不强求，pickInsetSlots），
 * 26px 的圆盘、名字、弧线、彗星都照画；标题写窗里真正框的那几台。小窗摆在主图最空的那个角
 * （placeInsets），主图上用一个细虚线框圈出这组盖住的范围，再拉一根引线到小窗。
 * 手机上窗里有名字摆不下（被藏了）时试着把窗放大到 52% × 62%：放大后都摆得下才留着，否则缩回去。
 *
 * 用户拖图 / 缩放时：圈和引线跟着主图走（每次布局报告都重算），小窗钉在框好时定下的角上不
 * 跟着跑 —— 摆位只在框好之后的报告（settled）上重算：首次、卡片变宽、主机集合变了、回到全览。
 * 圈整个滚出图外就不拉引线；用户放大到这组在屏幕上散开了，小窗和圈一起藏起来，缩回去再出现。
 * 画布自己记着用户动没动过（userMoved），动过就不再自动框，这里显示「回到全览」。
 *
 * 底图跟 /map 一样：用户在整页选过的优先（同一个 localStorage 键），没选过就跟面板主题。
 * 高德瓦片拉不下来时悄悄切到暗黑网格（主图和小窗一起切）—— 首页上不弹提示，那是整页的事。
 */
const NO_PADDING = { top: 0, bottom: 0, left: 0, right: 0 };
/** 点一下的提示停多久 */
const TIP_MS = 2500;

function readStoredLayer(): unknown {
  try { return window.localStorage.getItem(NETWORK_MAP_LAYER_STORAGE_KEY); } catch { return null; }
}

/** 框好时定下来的一扇小窗：哪几台、叫什么、摆哪 —— 用户拖图时这些不变。growKey：放大状态机按它记 */
type InsetSlot = { hostIds: number[]; label: string; placement: InsetPlacement; growKey: string };

export default function NetworkMapMini({ model, fallback }: {
  model: NetworkMapModel;
  /** 引擎起不来（没有 WebGL）时画这个：原来的示意图 */
  fallback: ReactNode;
}) {
  const { resolvedTheme } = useTheme();
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const desktop = useMediaQuery("(min-width: 900px)");
  const pageVisible = usePageVisible();
  const [baseLayer, setBaseLayer] = useState<NetworkMapBaseLayerId>(() => resolveNetworkMapBaseLayer(readStoredLayer(), resolvedTheme));
  const [unavailable, setUnavailable] = useState(false);
  /** 主图最近一次布局（拖图时每帧一份）：圈、引线、「回到全览」都看它 */
  const [report, setReport] = useState<MiniLayoutReport | null>(null);
  /** 最近一次框好之后的布局：小窗摆位只看它 */
  const [fitReport, setFitReport] = useState<MiniLayoutReport | null>(null);
  const [tip, setTip] = useState<string | null>(null);
  /** 手机上每扇小窗试没试过放大、结果如何（nextInsetGrowStage） */
  const [growStages, setGrowStages] = useState<Record<string, InsetGrowStage>>({});
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

  const onRasterError = useCallback(() => setBaseLayer("dark"), []);
  const onMiniLayout = useCallback((next: MiniLayoutReport) => {
    setReport(next);
    if (next.settled) setFitReport(next);
  }, []);
  const onReady = useCallback((api: NetworkMapCameraApi) => { apiRef.current = api; }, []);
  const showTip = useCallback((text: string) => {
    setTip(text);
    if (tipTimer.current) window.clearTimeout(tipTimer.current);
    tipTimer.current = window.setTimeout(() => setTip(null), TIP_MS);
  }, []);
  const unlocated = unlocatedHostCount(model);
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

  const placeLabelOf = useCallback((hostIds: readonly number[]) => {
    const cities = hostIds.map((id) => model.nodes.find((node) => node.id === id)?.city ?? "");
    return groupPlaceLabel(cities);
  }, [model]);

  // 哪几组开小窗、各框哪几台、小窗摆哪：框好之后定一次，拖图时不动
  const slots = useMemo<InsetSlot[]>(() => {
    if (!fitReport) return [];
    const picks = pickInsetSlots(fitReport.groups, desktop);
    if (picks.length === 0) return [];
    const growKeys = picks.map((pick) => `${pick.hostIds.join(",")}@${fitReport.width}x${fitReport.height}`);
    const grow = growKeys.map((key) => !desktop && (growStages[key] === "try" || growStages[key] === "keep"));
    const placements = placeInsets({ width: fitReport.width, height: fitReport.height }, { boxes: fitReport.boxes, points: fitReport.points, reserved: fitReport.reserved }, picks.length, desktop, undefined, grow);
    return placements.map((placement, index) => ({ hostIds: picks[index].hostIds, label: placeLabelOf(picks[index].hostIds) || picks[index].group.label, placement, growKey: growKeys[index] }));
  }, [fitReport, desktop, growStages, placeLabelOf]);
  const onInsetLayout = useCallback((slot: InsetSlot, next: InsetLayoutReport) => {
    setGrowStages((stages) => {
      const stage = nextInsetGrowStage(stages[slot.growKey], next, slot.placement.box, desktop);
      return stage === stages[slot.growKey] ? stages : { ...stages, [slot.growKey]: stage as InsetGrowStage };
    });
  }, [desktop]);
  // 圈哪、引线怎么拉：跟着主图最近一次布局走；这组在屏幕上散开了（放大了）就藏起来。
  // 圈只圈小窗真正框的那几台（加上主图上的叠起来的 marker）
  const insets = useMemo(() => slots.map((slot) => {
    const group = report ? matchInsetGroup(slot.hostIds, report.groups) : null;
    const points = group ? slot.hostIds.map((id) => group.members[group.hostIds.indexOf(id)]).filter(Boolean) : [];
    const coverage = group ? groupCoverageBox(points, group.markerBox) : null;
    const leader = report && coverage ? insetLeader(coverage, slot.placement.box, report) : null;
    return { ...slot, shown: !!group, coverage, leader };
  }), [slots, report]);
  // 主图上的延迟胶囊要躲开小窗（小窗摆位不看胶囊，所以不会互相追着跑）
  const avoidBoxes = useMemo(() => insets.filter((item) => item.shown).map((item) => item.placement.box), [insets]);

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
        onSelectNode={onSelectNode}
        onSelectLink={onSelectLink}
        onSelectTarget={noop}
        onSelectCluster={(_center, _zoom, hostIds) => {
          const group = report?.groups.find((item) => item.hostIds.join(",") === hostIds.join(","));
          if (group) showTip(groupTipText(group.label, group.hostIds.length));
        }}
        onMapClick={noop}
        onRasterError={onRasterError}
        onUnavailable={() => setUnavailable(true)}
        onMiniLayout={onMiniLayout}
        avoidBoxes={avoidBoxes}
        onReady={onReady}
      />
      {report && insets.some((item) => item.shown) ? (
        <svg className="nm-inset-links" width={report.width} height={report.height} viewBox={`0 0 ${report.width} ${report.height}`} aria-hidden="true">
          {insets.filter((item) => item.shown).map(({ hostIds, coverage, leader }) => (
            <g key={hostIds.join(",")}>
              {coverage ? <rect x={coverage.x} y={coverage.y} width={coverage.w} height={coverage.h} rx={7} /> : null}
              {leader ? <line x1={leader[0].x} y1={leader[0].y} x2={leader[1].x} y2={leader[1].y} /> : null}
            </g>
          ))}
        </svg>
      ) : null}
      {insets.map((slot) => {
        const { hostIds, label, placement, shown } = slot;
        return (
        // 组员变了（key 变）就整扇窗重建：旧的 MapLibre 实例随之销毁。组散了只是藏起来（visibility，尺寸不变，
        // 引擎不用重算），缩回去立刻又有
        <div key={hostIds.join(",")} className={`nm-inset${placement.shrunk ? " is-small" : ""}${placement.grown ? " is-grown" : ""}${shown ? "" : " is-off"}`} style={{ left: placement.box.x, top: placement.box.y, width: placement.box.w, height: placement.box.h }} aria-label={`局部放大：${label}，${hostIds.length} 台`}>
          <NetworkMapCanvas
            variant="inset"
            fitHostIds={hostIds}
            model={model}
            baseLayer={baseLayer}
            focus={null}
            showFlows={false}
            padding={NO_PADDING}
            reduceMotion={reduceMotion}
            paused={paused || !shown}
            comets
            onSelectNode={onSelectNode}
            onSelectLink={onSelectLink}
            onSelectTarget={noop}
            onSelectCluster={(_center, _zoom, ids) => showTip(groupTipText(placeLabelOf(ids), ids.length))}
            onMapClick={noop}
            onRasterError={onRasterError}
            onUnavailable={noop}
            onReady={noop}
            onInsetLayout={(next) => onInsetLayout(slot, next)}
          />
          <span className="nm-inset-title nm-reserved">{label} ×{hostIds.length}</span>
        </div>
        );
      })}
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
