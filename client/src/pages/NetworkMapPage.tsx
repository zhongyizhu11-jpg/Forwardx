import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "wouter";

import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";
import type { NetworkMapCameraApi } from "@/components/network/NetworkMapCanvas";
import { LinkPanelBody, LinkPanelTabs, PanelMenu, linkStatusLabel, type LinkLiveData, type LinkPanelTab, type LiveRange } from "@/components/network/NetworkMapLinkPanel";
import { NetworkMapSheet } from "@/components/network/NetworkMapSheet";
import { NodeDetailView, OverviewView, Pill, SheetHead, TargetDetailView, nodeHeadSubtitle, tone } from "@/components/network/NetworkMapSheetViews";
import "@/components/network/networkMap.css";
import { useTheme } from "@/contexts/ThemeContext";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { buildNetworkMapAlerts, type NetworkMapAlert } from "@/features/network/networkMapAlerts";
import { LINE_FILTER_OPTIONS, LINE_KINDS, LINE_KIND_LABELS, formatAvailability, lineTotal, overallAvailability, pickHubNode, type LineFilter } from "@/features/network/networkMapLines";
import { useNetworkMapPageModel } from "@/features/network/networkMapModel";
import { paddingForOverlays, sheetOverlayBox, type ContainerSize } from "@/features/network/networkMapOverlays";
import {
  RAIL_MIN_WIDTH,
  SHEET_HALF_RATIO,
  SHEET_PEEK_HEIGHT,
  focusForLink,
  focusForNode,
  focusForTarget,
  mapPaddingForSheet,
  overviewHeadline,
  parseMapOpenQuery,
  type MapFocus,
  type MapSheetView,
  type SheetSnap,
} from "@/features/network/networkMapPageState";
import { latencyWindows, summarizeHostSeries, summarizeLatencySeries, sumTraffic, trafficRateWindows } from "@/features/network/networkMapSeries";
import { copyTextToClipboard } from "@/lib/clipboard";
import { trpc } from "@/lib/trpc";
import { hostNeedsAgentUpgrade } from "@shared/fxpRuntime";
import {
  NETWORK_MAP_ALL_BASE_LAYERS,
  NETWORK_MAP_AMAP_TERMS_NOTE,
  NETWORK_MAP_BASE_LAYERS,
  NETWORK_MAP_BASE_LAYER_ORDER,
  browserLayerStorage,
  readNetworkMapBaseLayer,
  rememberNetworkMapBaseLayer,
  type NetworkMapBaseLayerId,
} from "@shared/networkMapBaseLayers";
import { describeNetworkHealth } from "@shared/networkHealth";
import type { PixelBox } from "@shared/networkMapGeometry";
import { AGENT_VERSION } from "@shared/versions";

/**
 * 网络地图整页（/map）：夜里的网络运维大屏 —— 夜晚的地球上，主机是发光的环，隧道是霓虹弧线。
 *
 * 图上浮着几样东西（都是 .nm-reserved，名字会躲开它们）：
 *   左上   标题「网络地图」和一排统计卡（主机节点、链路线路、需要处理、整体可用率）；
 *          选中一条隧道时标题换成「← 隧道名」和主备对比的小图例
 *   右上   底图三段切换（标准地图 / 卫星地图 / 暗黑网格）
 *   右边   竖着的工具栏：图层（含高德）、全览、流向（落地流向和光点）、筛选（按四类线）
 *   左下   图例：主线路 / 备用线路 / 降级线路 / 中断线路，各几条
 *
 * 手机（< 640px）上这些要让出地图：标题只留一行「网络地图」，统计卡缩成一行四个小胶囊
 * （「7 主机」「3 线路」…），工具栏只剩图标、竖在右下角抽屉上面，图例收成一个「图例」小条、点开才是
 * 2×2 的四类线，底图切换收进「图层」菜单。
 *
 * 地图的留白不再写死：页面量出这些浮层（和抽屉 / 详情卡）的真实盒子，算出一块不被盖住的矩形
 * （paddingForOverlays）交给画布；画布在这块矩形里按 marker 真正占的像素精确框住全部，浮层变了
 * （图例展开、抽屉换档、详情卡开关）而用户没动过图就重新框一遍。
 *
 * 详情：桌面上是浮在图右边的一张玻璃卡（选中东西或点了统计卡才出来），手机上是底部抽屉；
 * 选中隧道时有五个标签（NetworkMapLinkPanel）。
 *
 * 地图引擎（MapLibre）单独一个包、lazy 进来；这页自己只管状态：底图、抽屉、当前视图、聚焦、筛选，
 * 以及点开详情时才取的那几条序列。模型和首页那块卡片共用（features/network/networkMapModel）。
 */

const NetworkMapCanvas = lazy(() => import("@/components/network/NetworkMapCanvas"));

const HOUR = 3_600_000;
/** 实时数据的两档：取两倍时长（和前一段比），桶长 */
const LIVE_RANGES: Record<LiveRange, { hours: number; rangeMs: number; bucketMinutes: number }> = {
  "1h": { hours: 2, rangeMs: HOUR, bucketMinutes: 5 },
  "24h": { hours: 48, rangeMs: 24 * HOUR, bucketMinutes: 60 },
};

/**
 * 让这一块铺满工作区：DashboardLayout 的 main 有内边距和 1280px 的最大宽度，
 * 这里量出自己离工作区边缘有多远、底下还有多少留白（手机端的标签栏、桌面的页脚），
 * 用负外边距和算出来的高度铺过去。量而不是写死，是因为那些留白全是变量（安全区、
 * 有没有标签栏、有没有顶部横幅），抄一遍公式过两版就对不上了。
 */
function useFullBleedFrame(ref: React.RefObject<HTMLDivElement | null>) {
  const [frame, setFrame] = useState<{ marginLeft: number; width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => {
      const parent = element.parentElement;
      const main = element.closest("main") as HTMLElement | null;
      const inset = (main?.parentElement as HTMLElement | null) ?? main;
      if (!parent || !inset) return;
      const parentRect = parent.getBoundingClientRect();
      const insetRect = inset.getBoundingClientRect();
      const bottomPad = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0;
      const footer = inset.querySelector(":scope > footer") as HTMLElement | null;
      const footerHeight = footer ? footer.offsetHeight : 0;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const height = Math.max(360, Math.floor(viewportHeight - parentRect.top - bottomPad - footerHeight));
      setFrame({ marginLeft: -(parentRect.left - insetRect.left), width: insetRect.width, height });
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    const main = element.closest("main");
    if (observer) { observer.observe(document.documentElement); if (main?.parentElement) observer.observe(main.parentElement); }
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [ref]);
  return frame;
}

/** 手机布局（一行标题、小胶囊、右下角只剩图标的工具栏、收起的图例）的宽度分界 */
const COMPACT_MAX_WIDTH = 639;

type OverlayMeasure = { size: ContainerSize; boxes: PixelBox[] };

/**
 * 量浮在地图上的东西占了哪些地方（相对地图容器）：地图这一层里所有 .nm-reserved（标题、统计、工具栏、
 * 图例、对比卡、退出聚焦），加上 sheetBox（手机上按抽屉档位算 —— 抽屉是 transform 动画，量 DOM 会量到
 * 动画中间；桌面上量那张详情卡）。
 *
 * 每次渲染后量一遍（图例展开、选中东西换了标题这些都会重新渲染），再用 ResizeObserver 盯着容器和
 * 每块浮层（字体晚到、转屏这些不经过 React 的变化）；结果没变就不 setState。
 */
function useOverlayBoxes(wrapRef: React.RefObject<HTMLDivElement | null>, sheetBox: (size: ContainerSize, layout: HTMLElement) => PixelBox | null): OverlayMeasure | null {
  const [measure, setMeasure] = useState<OverlayMeasure | null>(null);
  const signature = useRef("");
  const observer = useRef<ResizeObserver | null>(null);
  const observed = useRef(new WeakSet<Element>());
  const run = useRef<() => void>(() => {});
  run.current = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const frame = wrap.getBoundingClientRect();
    const size = { width: Math.round(frame.width), height: Math.round(frame.height) };
    if (size.width <= 0 || size.height <= 0) return;
    const boxes: PixelBox[] = [];
    for (const element of Array.from(wrap.querySelectorAll<HTMLElement>(".nm-reserved"))) {
      if (element.closest(".nm-map")) continue;
      if (observer.current && !observed.current.has(element)) { observer.current.observe(element); observed.current.add(element); }
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      boxes.push({ x: Math.round(rect.left - frame.left), y: Math.round(rect.top - frame.top), w: Math.round(rect.width), h: Math.round(rect.height) });
    }
    const sheet = wrap.parentElement ? sheetBox(size, wrap.parentElement) : null;
    if (sheet && sheet.w > 0 && sheet.h > 0) boxes.push(sheet);
    const next = JSON.stringify([size, boxes]);
    if (next === signature.current) return;
    signature.current = next;
    setMeasure({ size, boxes });
  };
  useLayoutEffect(() => { run.current(); });
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => run.current());
    observer.current = ro;
    observed.current = new WeakSet();
    if (wrapRef.current) ro.observe(wrapRef.current);
    run.current();
    return () => { ro.disconnect(); observer.current = null; };
  }, [wrapRef]);
  return measure;
}

type IconName = "layers" | "fit" | "flow" | "filter" | "server" | "link" | "alert" | "pulse" | "back";
const ICON_PATHS: Record<IconName, ReactNode> = {
  layers: <><path d="M12 3 2.5 8 12 13l9.5-5L12 3z" /><path d="m2.5 12.5 9.5 5 9.5-5" /><path d="m2.5 17 9.5 5 9.5-5" /></>,
  fit: <><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" /><circle cx="12" cy="12" r="2.5" /></>,
  flow: <><path d="M3 17c4-8 10-8 14-3" /><path d="m15 10 2.6 4.2L13 15" /><circle cx="6" cy="14.5" r="1" /><circle cx="10" cy="11.6" r="1" /></>,
  filter: <><path d="M4 5h16l-6.2 7.3V19l-3.6-1.8v-4.9L4 5z" /></>,
  server: <><rect x="4" y="4" width="16" height="6.5" rx="1.6" /><rect x="4" y="13.5" width="16" height="6.5" rx="1.6" /><path d="M7.5 7.3h.01M7.5 16.8h.01" /></>,
  link: <><path d="M10 14a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1 1" /><path d="M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1-1" /></>,
  alert: <><path d="M12 4 2.8 19.5h18.4L12 4z" /><path d="M12 10v4.2M12 17h.01" /></>,
  pulse: <><path d="M3 12h4l2.5-6 5 12 2.5-6H21" /></>,
  back: <><path d="M15 6l-6 6 6 6" /></>,
};
function Icon({ name }: { name: IconName }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">{ICON_PATHS[name]}</svg>;
}

export default function NetworkMapPage() {
  return (
    <DashboardLayout>
      <NetworkMapPageBody />
    </DashboardLayout>
  );
}

function NetworkMapPageBody() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [, setLocation] = useLocation();
  const { resolvedTheme } = useTheme();
  const rail = useMediaQuery(`(min-width: ${RAIL_MIN_WIDTH}px)`);
  const compactChrome = useMediaQuery(`(max-width: ${COMPACT_MAX_WIDTH}px)`);
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const publicInfo = trpc.system.publicInfo.useQuery(undefined, { enabled: !!user, retry: false, refetchOnWindowFocus: false });
  const canNetworkTest = isAdmin || publicInfo.data?.lookingGlassUserEnabled === true;

  const frameRef = useRef<HTMLDivElement | null>(null);
  const frame = useFullBleedFrame(frameRef);
  const mapWrapRef = useRef<HTMLDivElement | null>(null);
  const [containerHeight, setContainerHeight] = useState(0);
  useLayoutEffect(() => {
    const wrap = mapWrapRef.current;
    if (!wrap) return undefined;
    const update = () => setContainerHeight(wrap.clientHeight);
    update();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(wrap);
    return () => observer?.disconnect();
  }, [frame]);

  // ---- 底图：记住的优先，默认标准地图（夜晚的地球）；地图永远深色，抽屉跟面板主题 ----
  const [baseLayer, setBaseLayer] = useState<NetworkMapBaseLayerId>(() => readNetworkMapBaseLayer(browserLayerStorage()));
  const [menu, setMenu] = useState<"layers" | "filter" | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const chooseLayer = (id: NetworkMapBaseLayerId) => {
    setBaseLayer(id);
    setMenu(null);
    rememberNetworkMapBaseLayer(browserLayerStorage(), id);
  };
  useEffect(() => {
    if (!menu) return undefined;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || toolbarRef.current?.contains(target)) return;
      setMenu(null);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [menu]);
  const skin = resolvedTheme;

  // ---- 数据 ----
  const model = useNetworkMapPageModel({ enabled: !!user, withTargets: isAdmin });
  const alerts = useMemo(() => buildNetworkMapAlerts(model), [model]);
  // 「流向」：落地流向（只给管理员）和主线路上的光点一起开关
  const [showFlows, setShowFlows] = useState(true);
  const flowsOn = isAdmin && showFlows;
  const [lineFilter, setLineFilter] = useState<LineFilter>("all");

  // ---- 抽屉 / 视图 / 聚焦 ----
  const [snap, setSnap] = useState<SheetSnap>("peek");
  const [view, setView] = useState<MapSheetView>({ view: "overview" });
  /** 桌面：没选中东西时，点了统计卡也打开右边的卡看总览 */
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [linkTab, setLinkTab] = useState<LinkPanelTab>("overview");
  const [liveRange, setLiveRange] = useState<LiveRange>("1h");
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [toastText, setToastText] = useState<string | null>(null);
  const [mapUnavailable, setMapUnavailable] = useState(false);
  const toastTimer = useRef<number | null>(null);
  const toast = useCallback((text: string) => {
    setToastText(text);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastText(null), 2400);
  }, []);
  const panelOpen = rail && (view.view !== "overview" || overviewOpen);
  const cameraRef = useRef<NetworkMapCameraApi | null>(null);
  const pendingCamera = useRef<(() => void) | null>(null);
  // ---- 地图留白：按浮层的真实盒子算（量到之前先用按档位估的那份）----
  // 手机上抽屉按档位算它盖住多少；桌面上量那张详情卡（关着时 display: none，量出来是空的）
  const overlays = useOverlayBoxes(mapWrapRef, (size, layout) => {
    if (!rail) return sheetOverlayBox(snap, size);
    const sheet = layout.querySelector(":scope > .nm-sheet") as HTMLElement | null;
    const rect = sheet?.getBoundingClientRect();
    const frame = layout.getBoundingClientRect();
    return rect && rect.width > 0 ? { x: Math.round(rect.left - frame.left), y: Math.round(rect.top - frame.top), w: Math.round(rect.width), h: Math.round(rect.height) } : null;
  });
  const padding = useMemo(
    () => (overlays ? paddingForOverlays(overlays.size, overlays.boxes) : mapPaddingForSheet(snap, containerHeight, rail, panelOpen)),
    [overlays, snap, containerHeight, rail, panelOpen],
  );
  // 手机上工具栏、图例、提示条坐在抽屉露出的那截上面：收起时 84px，半屏时 48%（全屏时抽屉盖住它们，按半屏放）
  const dock = rail ? 0 : snap === "peek" ? SHEET_PEEK_HEIGHT : Math.round(containerHeight * SHEET_HALF_RATIO);
  const [legendOpen, setLegendOpen] = useState(false);
  // 相机动作排在这次渲染之后：先让抽屉 / 详情卡的新尺寸通过 setPadding 告诉地图（画布的 effect 先跑），再飞
  useEffect(() => {
    const action = pendingCamera.current;
    if (!action) return;
    pendingCamera.current = null;
    action();
  });
  const queueCamera = (action: (api: NetworkMapCameraApi) => void) => {
    pendingCamera.current = () => { if (cameraRef.current) action(cameraRef.current); };
  };
  const raiseSheet = () => { if (!rail && snap === "peek") setSnap("half"); };

  const openNode = (hostId: number, options: { fly?: boolean; focus?: boolean } = {}) => {
    setView({ view: "node", id: hostId });
    raiseSheet();
    if (options.focus !== false) setFocus(focusForNode(model, hostId));
    if (options.fly !== false) queueCamera((api) => { const at = api.hostLngLat(hostId); if (at) api.flyTo(at, Math.max(api.getZoom(), 5)); });
  };
  /** 框住一次聚焦里的所有主机（主备对比时连备用经过的主机一起） */
  const fitFocus = (next: MapFocus | null, maxZoom: number) => queueCamera((api) => {
    if (!next) return;
    // 和「全览」一样在留白里按 marker 真正占的像素框：聚焦的那几台连名字都在看得见的地方
    api.fitMarkers(next.hosts, next.targets, maxZoom);
  });
  const openLink = (tunnelId: number, options: { fly?: boolean; focus?: boolean } = {}) => {
    const next = focusForLink(model, tunnelId);
    if (view.view !== "link" || view.id !== tunnelId) setLinkTab("overview");
    setView({ view: "link", id: tunnelId });
    raiseSheet();
    if (options.focus !== false) setFocus(next);
    if (options.fly !== false) fitFocus(next, 6.5);
  };
  const openTarget = (key: string) => {
    setView({ view: "target", id: key });
    raiseSheet();
    setFocus(focusForTarget(model, key));
    queueCamera((api) => { const at = api.targetLngLat(key); if (at) api.flyTo(at, Math.max(api.getZoom(), 5)); });
  };
  const backToOverview = () => {
    setView({ view: "overview" });
    setFocus(null);
  };
  const closePanel = () => {
    setView({ view: "overview" });
    setFocus(null);
    setOverviewOpen(false);
    if (!rail) setSnap("peek");
  };
  const fitAll = () => {
    setFocus(null);
    setView({ view: "overview" });
    queueCamera((api) => api.fitAll());
  };
  const showOverview = () => {
    setView({ view: "overview" });
    setFocus(null);
    setOverviewOpen(true);
    if (!rail) setSnap("half");
  };
  const focusAlert = (alert: NetworkMapAlert) => {
    const next = { ...alert.focus, label: alert.title, severity: alert.severity };
    setFocus(next);
    if (alert.open.view === "link") openLink(Number(alert.open.id), { fly: false, focus: false });
    else if (alert.open.view === "target") { setView({ view: "target", id: String(alert.open.id) }); raiseSheet(); }
    else openNode(Number(alert.open.id), { fly: false, focus: false });
    fitFocus(next as MapFocus, 6.5);
  };

  // 点开的东西没了（被删了、权限变了）就回总览
  useEffect(() => {
    if (view.view === "node" && !model.nodes.some((node) => node.id === view.id)) setView({ view: "overview" });
    if (view.view === "link" && !model.links.some((link) => link.id === view.id)) setView({ view: "overview" });
    if (view.view === "target" && !model.targets.some((target) => target.key === view.id)) setView({ view: "overview" });
  }, [model, view]);

  // ---- 首页小图带着 ?host= / ?link= 过来：模型里有它、相机也就位了就开一次详情并飞过去 ----
  const [pendingOpen, setPendingOpen] = useState(() => (typeof window !== "undefined" ? parseMapOpenQuery(window.location.search) : null));
  const [cameraReady, setCameraReady] = useState(false);
  useEffect(() => {
    if (!pendingOpen || !cameraReady || model.loading) return;
    const exists = pendingOpen.view === "node" ? model.nodes.some((node) => node.id === pendingOpen.id) : model.links.some((link) => link.id === pendingOpen.id);
    // 模型到了但没有这个东西（被删了、不是自己的）：不再等，留在总览
    setPendingOpen(null);
    if (!exists) return;
    if (pendingOpen.view === "node") openNode(pendingOpen.id);
    else openLink(pendingOpen.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOpen, cameraReady, model]);

  // ---- 页面不可见时停掉流动光点 ----
  const [paused, setPaused] = useState(() => typeof document !== "undefined" && document.visibilityState !== "visible");
  useEffect(() => {
    const onVisibility = () => setPaused(document.visibilityState !== "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // ---- 高德拉不下来：切回标准地图，不写进 localStorage（网络回来了还用用户选的） ----
  const onRasterError = useCallback(() => {
    setBaseLayer("night");
    toast("高德底图加载失败，已切回标准地图");
  }, [toast]);

  // ---- 详情要的数据：点开时才取 ----
  const nodeId = view.view === "node" ? view.id : 0;
  const linkId = view.view === "link" ? view.id : 0;
  const metricsQuery = trpc.hosts.metricsSeries.useQuery({ hostId: nodeId, hours: 24 }, { enabled: nodeId > 0, staleTime: 30_000, refetchInterval: nodeId > 0 ? 60_000 : false });
  const vitals = useMemo(() => (metricsQuery.data ? summarizeHostSeries(metricsQuery.data as any) : null), [metricsQuery.data]);
  const latencyQuery = trpc.tunnels.latencySeries.useQuery({ tunnelId: linkId, hours: 24 }, { enabled: linkId > 0, retry: false, staleTime: 15_000, refetchInterval: linkId > 0 ? 60_000 : false });
  const latency = useMemo(() => (latencyQuery.data ? summarizeLatencySeries(latencyQuery.data as any) : null), [latencyQuery.data]);
  const linkRuleIds = useMemo(() => model.rules.filter((rule) => rule.tunnelId === linkId).map((rule) => rule.id), [model.rules, linkId]);
  const trafficDayQuery = trpc.rules.trafficSummary.useQuery({ range: "24h", hours: 24, ruleIds: linkRuleIds }, { enabled: linkId > 0 && linkRuleIds.length > 0, staleTime: 30_000 });
  const trafficTotalQuery = trpc.rules.trafficSummary.useQuery({ range: "total", ruleIds: linkRuleIds }, { enabled: linkId > 0 && linkRuleIds.length > 0, staleTime: 60_000 });
  const traffic = useMemo(() => ({
    day: linkRuleIds.length === 0 ? { bytesIn: 0, bytesOut: 0 } : trafficDayQuery.data ? sumTraffic(trafficDayQuery.data as any, linkRuleIds) : null,
    total: linkRuleIds.length === 0 ? { bytesIn: 0, bytesOut: 0 } : trafficTotalQuery.data ? sumTraffic(trafficTotalQuery.data as any, linkRuleIds) : null,
  }), [linkRuleIds, trafficDayQuery.data, trafficTotalQuery.data]);
  // 实时数据：两倍时长（这一段 + 前一段），速率从规则的逐桶字节算，延迟和探测成功率从延迟序列算
  const liveSpec = LIVE_RANGES[liveRange];
  const liveLatencyQuery = trpc.tunnels.latencySeries.useQuery({ tunnelId: linkId, hours: liveSpec.hours }, { enabled: linkId > 0, retry: false, staleTime: 15_000, refetchInterval: linkId > 0 ? 60_000 : false });
  const liveTrafficQuery = trpc.rules.trafficSeriesBatch.useQuery({ ruleIds: linkRuleIds, hours: liveSpec.hours, bucketMinutes: liveSpec.bucketMinutes }, { enabled: linkId > 0 && linkRuleIds.length > 0, staleTime: 30_000, refetchInterval: linkId > 0 ? 60_000 : false });
  const live = useMemo<LinkLiveData>(() => {
    const nowMs = Date.now();
    const rates = linkRuleIds.length > 0 && liveTrafficQuery.data
      ? trafficRateWindows(liveTrafficQuery.data as any, { ruleIds: linkRuleIds, nowMs, rangeMs: liveSpec.rangeMs, bucketMs: liveSpec.bucketMinutes * 60_000 })
      : null;
    const latencyLive = liveLatencyQuery.data ? latencyWindows(liveLatencyQuery.data as any, { nowMs, rangeMs: liveSpec.rangeMs }) : null;
    return {
      down: rates?.down ?? null,
      up: rates?.up ?? null,
      latency: latencyLive?.current ?? null,
      latencyDelta: latencyLive?.delta ?? null,
      loading: liveLatencyQuery.isLoading || (linkRuleIds.length > 0 && liveTrafficQuery.isLoading),
    };
  }, [linkRuleIds, liveTrafficQuery.data, liveLatencyQuery.data, liveSpec, liveLatencyQuery.isLoading, liveTrafficQuery.isLoading]);

  const utils = trpc.useUtils();
  const upgradeMutation = trpc.hosts.requestAgentUpgrade.useMutation({
    onSuccess: (data: any) => {
      void utils.hosts.options.invalidate();
      if (data?.skippedOffline) { toast("主机离线，已跳过升级任务"); return; }
      if (data?.alreadyLatest) { toast("该 Agent 已经是最新版本"); return; }
      toast(data?.pushed ? "Agent 升级任务已推送，正在升级" : "升级任务已记录，等 Agent 回连后执行");
    },
    onError: (error) => toast(error.message || "下发升级任务失败"),
  });
  const testMutation = trpc.tunnels.test.useMutation({
    onSuccess: () => {
      void utils.tunnels.options.invalidate();
      toast("诊断已发出，结果几十秒后回到这条线上");
    },
    onError: (error) => toast(error.message || "诊断没发出去"),
  });

  const copyText = async (text: string) => {
    if (await copyTextToClipboard(text)) toast(`已复制 ${text}`);
    else toast("这个浏览器不让复制，长按选中吧");
  };

  // ---- 统计 ----
  const hub = pickHubNode(model, view.view === "node" ? view.id : null);
  const availability = overallAvailability(model);
  // short：手机上一行四个小胶囊用的短标签（「7 主机」「99.7% 可用」）
  const stats = [
    { key: "hosts", icon: "server" as const, value: String(model.nodes.length), label: "主机节点", short: "主机", tone: "" },
    { key: "lines", icon: "link" as const, value: String(lineTotal(model)), label: "链路线路", short: "线路", tone: "" },
    { key: "alerts", icon: "alert" as const, value: String(alerts.length), label: "需要处理", short: "待处理", tone: alerts.length > 0 ? "is-alert" : "is-calm" },
    { key: "uptime", icon: "pulse" as const, value: formatAvailability(availability), label: "整体可用率", short: "可用", tone: availability === null ? "is-calm" : "is-good" },
  ];

  // ---- 抽屉内容 ----
  const headline = overviewHeadline(model, alerts.length);
  const currentNode = view.view === "node" ? model.nodes.find((node) => node.id === view.id) : undefined;
  const currentLink = view.view === "link" ? model.links.find((link) => link.id === view.id) : undefined;
  const currentTarget = view.view === "target" ? model.targets.find((target) => target.key === view.id) : undefined;
  const viewDetail = () => setLocation(isAdmin ? "/tunnels" : "/rules");
  let head: ReactNode;
  let body: ReactNode;
  if (currentNode) {
    const canUpgrade = isAdmin && hostNeedsAgentUpgrade(currentNode, AGENT_VERSION);
    head = <SheetHead onBack={backToOverview} onClose={closePanel} title={`${currentNode.emoji ? `${currentNode.emoji} ` : ""}${currentNode.name}`} subtitle={nodeHeadSubtitle(currentNode, model)} trailing={<Pill tone={tone(currentNode.health)}>{currentNode.isOnline ? "在线" : currentNode.lastHeartbeat ? "离线" : "未接入"}</Pill>} />;
    body = (
      <NodeDetailView
        model={model}
        node={currentNode}
        vitals={vitals}
        vitalsLoading={metricsQuery.isLoading}
        memoryTotal={currentNode.memoryTotal}
        now={Date.now()}
        onUpgrade={canUpgrade ? () => upgradeMutation.mutate({ hostId: currentNode.id }) : null}
        upgrading={upgradeMutation.isPending}
        onNetworkTest={canNetworkTest ? () => setLocation("/looking-glass") : null}
        onHostDetail={() => setLocation("/hosts")}
        onOpenLink={(id) => openLink(id)}
        onCopy={(text) => { void copyText(text); }}
      />
    );
  } else if (currentLink) {
    const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
    const ends = `${nodeById.get(currentLink.path[0])?.city ?? "看不到的主机"} → ${nodeById.get(currentLink.path[currentLink.path.length - 1])?.city ?? "看不到的主机"}`;
    head = (
      <>
        <SheetHead
          onClose={closePanel}
          title={currentLink.name}
          subtitle={`${ends} · ${currentLink.modeLabel}`}
          trailing={<Pill tone={tone(currentLink.health)}>{linkStatusLabel(currentLink)}</Pill>}
          actions={<PanelMenu items={[
            { label: testMutation.isPending ? "诊断中…" : "诊断这条线", onClick: () => testMutation.mutate({ id: currentLink.id }), disabled: testMutation.isPending },
            { label: "在地图上框住", onClick: () => fitFocus(focus, 6.5) },
            { label: isAdmin ? "打开链路管理" : "打开转发规则", onClick: viewDetail },
            { label: "回到全部线路", onClick: backToOverview },
          ]} />}
        />
        <LinkPanelTabs tab={linkTab} onTab={setLinkTab} />
      </>
    );
    body = (
      <LinkPanelBody
        model={model}
        link={currentLink}
        tab={linkTab}
        onTab={setLinkTab}
        range={liveRange}
        onRange={setLiveRange}
        live={live}
        detail={{
          latency,
          latencyLoading: latencyQuery.isLoading,
          latencyError: latencyQuery.error ? "看不到这条隧道的延迟历史" : null,
          traffic,
          onDiagnose: () => testMutation.mutate({ id: currentLink.id }),
          diagnosing: testMutation.isPending,
          onOpenNode: (id) => openNode(id),
        }}
        onOpenNode={(id) => openNode(id)}
        onFocusPath={() => { const next = focusForLink(model, currentLink.id); setFocus(next); fitFocus(next, 6.5); if (!rail) setSnap("peek"); }}
        onViewDetail={viewDetail}
        viewDetailLabel="查看详情"
      />
    );
  } else if (currentTarget) {
    head = <SheetHead onBack={backToOverview} onClose={closePanel} title={`${currentTarget.emoji ? `${currentTarget.emoji} ` : ""}${currentTarget.city} · 落地节点`} subtitle={currentTarget.address} trailing={<Pill tone={tone(currentTarget.health)}>{currentTarget.health === "healthy" ? "规则在跑" : describeNetworkHealth(currentTarget.health).label}</Pill>} />;
    body = <TargetDetailView model={model} target={currentTarget} onOpenLink={(id) => openLink(id)} onOpenNode={(id) => openNode(id)} />;
  } else {
    head = (
      <SheetHead
        onClose={rail ? closePanel : undefined}
        title={<>{headline.main}{headline.attention ? <span style={{ color: "var(--nm-warn)" }}> · {headline.attention}</span> : null}</>}
        subtitle={model.loading ? "正在读取主机和线路…" : model.error ? "有些数据没读到，看到的可能不完整" : "点主机或线路看详情 · 点告警会飞过去"}
      />
    );
    body = <OverviewView model={model} alerts={alerts} onAlert={focusAlert} onOpenNode={(id) => openNode(id)} onOpenLink={(id) => openLink(id)} baseLayerAmap={NETWORK_MAP_BASE_LAYERS[baseLayer].amap} />;
  }
  const viewKey = view.view === "overview" ? "overview" : `${view.view}:${view.id}:${view.view === "link" ? linkTab : ""}`;
  const compare = focus?.compare && currentLink && focus.compare.tunnelId === currentLink.id ? focus.compare : null;
  const filterCounts: Record<LineFilter, number> = { all: lineTotal(model), ...model.lines };

  return (
    <div
      ref={frameRef}
      className="fx-netmap"
      data-skin={skin}
      style={frame ? { marginLeft: frame.marginLeft, width: frame.width, height: frame.height } : { height: "70vh" }}
    >
      <div className={`nm-layout${panelOpen ? " has-panel" : ""}${compactChrome ? " is-compact" : ""}`} style={{ ["--nm-dock" as string]: `${dock}px` }}>
        <div ref={mapWrapRef} className="nm-map-wrap nm-surface">
          <Suspense fallback={<div className="nm-map-fallback">正在加载地图引擎…</div>}>
            <NetworkMapCanvas
              model={model}
              baseLayer={baseLayer}
              skin={skin}
              focus={focus}
              showFlows={flowsOn}
              padding={padding}
              overlayBoxes={overlays?.boxes}
              reduceMotion={reduceMotion}
              paused={paused}
              hubHostId={hub}
              lineFilter={lineFilter}
              onSelectNode={(id) => openNode(id)}
              onSelectLink={(id) => openLink(id)}
              onSelectTarget={openTarget}
              onSelectCluster={() => { if (!rail && snap !== "peek") setSnap("peek"); }}
              onMapClick={() => { if (menu) { setMenu(null); return; } if (!rail && snap !== "peek") setSnap("peek"); }}
              comets={showFlows}
              onRasterError={onRasterError}
              onUnavailable={() => setMapUnavailable(true)}
              onReady={(api) => { cameraRef.current = api; setCameraReady(true); }}
            />
          </Suspense>
          {mapUnavailable ? (
            <div className="nm-map-fallback">
              <div>这个浏览器画不了地图（没有 WebGL）。主机和线路仍在{rail ? "右侧" : "下方"}列表里，或换个开了硬件加速的浏览器再看。</div>
            </div>
          ) : !model.loading && model.nodes.length === 0 ? (
            <div className="nm-map-fallback" style={{ pointerEvents: "none" }}>
              <div>还没有主机。装好第一台 Agent，它就会出现在这张图上。</div>
            </div>
          ) : null}
          <div className={`nm-focus-mask${focus ? " is-show" : ""}`} aria-hidden="true" />
          <div className={`nm-hud-tl${compare ? " is-compare" : ""}`}>
            {compare && currentLink ? (
              <div className="nm-compare nm-glass nm-reserved">
                <button type="button" className="nm-back-chip" onClick={fitAll} aria-label={`退出主备线路对比：${currentLink.name}`}><Icon name="back" /><span>{currentLink.name}</span></button>
                <span className="nm-legend-row" aria-label="主备线路对比">
                  <span className="nm-legend-item"><i className="nm-line-swatch is-main" />主线路（当前）</span>
                  <span className="nm-legend-item"><i className="nm-line-swatch is-backup" />备用线路{compare.backupTunnels.length + compare.backupRoutes.length > 0 ? ` ${compare.backupTunnels.length + compare.backupRoutes.length}` : "（无）"}</span>
                  <span className="nm-legend-item"><i className="nm-line-swatch is-degraded" />降级</span>
                  <span className="nm-legend-item"><i className="nm-line-swatch is-down" />中断</span>
                </span>
              </div>
            ) : (
              <div className="nm-titlebar nm-reserved">
                <h1>网络地图</h1>
                {compactChrome ? null : <p>实时展示全球节点与链路状态</p>}
              </div>
            )}
            {focus && !compare ? (
              <button type="button" className="nm-focus-exit nm-reserved" onClick={fitAll}>
                <span className="nm-sev" style={{ background: focus.severity === "error" ? "var(--nm-down)" : focus.severity === "warning" ? "var(--nm-warn)" : "var(--nm-accent)" }} aria-hidden="true" />
                <span className="nm-text">退出聚焦 · {focus.label}</span>
                <span aria-hidden="true">✕</span>
              </button>
            ) : null}
            <div className="nm-stats" role="list" aria-label="概况">
              {stats.map((stat) => (
                <button key={stat.key} type="button" role="listitem" className={`nm-stat nm-glass nm-reserved ${stat.tone}`} onClick={showOverview} title={`${stat.label}：${stat.value}，打开总览`} aria-label={`${stat.label} ${stat.value}，打开总览`}>
                  <span className="nm-icon"><Icon name={stat.icon} /></span>
                  <b>{stat.value}</b>
                  <span className="nm-stat-label">{compactChrome ? stat.short : stat.label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="nm-seg nm-glass nm-reserved" role="radiogroup" aria-label="底图">
            {NETWORK_MAP_BASE_LAYER_ORDER.map((id) => (
              <button key={id} type="button" role="radio" aria-checked={baseLayer === id} onClick={() => chooseLayer(id)}>{NETWORK_MAP_BASE_LAYERS[id].label}</button>
            ))}
          </div>
          {/* 手机上只剩图标（文字藏起来，aria-label 和悬停提示还在） */}
          <div ref={toolbarRef} className="nm-toolbar nm-glass nm-reserved" role="toolbar" aria-label="地图工具">
            <button type="button" className={menu === "layers" ? "is-active" : ""} aria-expanded={menu === "layers"} aria-label="图层" title="图层：换底图" onClick={() => setMenu((open) => (open === "layers" ? null : "layers"))}><Icon name="layers" /><span className="nm-tool-label">图层</span></button>
            <button type="button" aria-label="全览" title="全览：框住全部主机" onClick={fitAll}><Icon name="fit" /><span className="nm-tool-label">全览</span></button>
            <button type="button" className={showFlows ? "is-active" : ""} aria-pressed={showFlows} aria-label="流向" onClick={() => setShowFlows((value) => !value)} title={isAdmin ? "流向：落地流向和主线路上的光点" : "流向：主线路上的光点"}><Icon name="flow" /><span className="nm-tool-label">流向</span></button>
            <button type="button" className={menu === "filter" || lineFilter !== "all" ? "is-active" : ""} aria-expanded={menu === "filter"} aria-label="筛选" title="筛选：只看某一类线" onClick={() => setMenu((open) => (open === "filter" ? null : "filter"))}><Icon name="filter" /><span className="nm-tool-label">筛选</span>{lineFilter !== "all" ? <i className="nm-badge" aria-hidden="true" /> : null}</button>
          </div>
          {menu === "layers" ? (
            <div ref={menuRef} className="nm-pop nm-glass" role="menu" aria-label="底图" style={compactChrome ? undefined : { top: rail ? 64 : 146 }}>
              <div className="nm-menu-title">底图</div>
              {NETWORK_MAP_ALL_BASE_LAYERS.map((id) => {
                const layer = NETWORK_MAP_BASE_LAYERS[id];
                return (
                  <button key={id} type="button" role="menuitemradio" aria-checked={baseLayer === id} className="nm-opt" onClick={() => chooseLayer(id)}>
                    <span className={`nm-swatch ${id}`} aria-hidden="true" />
                    <span><b>{layer.label}</b><small>{layer.hint}</small></span>
                    <span className="nm-check" aria-hidden="true" />
                  </button>
                );
              })}
              <div className="nm-menu-foot">{NETWORK_MAP_AMAP_TERMS_NOTE}</div>
            </div>
          ) : null}
          {menu === "filter" ? (
            <div ref={menuRef} className="nm-pop nm-glass" role="menu" aria-label="筛选线路" style={compactChrome ? undefined : { top: rail ? 190 : 270 }}>
              <div className="nm-menu-title">只看这些线</div>
              {LINE_FILTER_OPTIONS.map((option) => (
                <button key={option.id} type="button" role="menuitemradio" aria-checked={lineFilter === option.id} className="nm-opt" onClick={() => { setLineFilter(option.id); setMenu(null); }}>
                  {option.id === "all" ? <span className="nm-line-swatch" aria-hidden="true" style={{ background: "linear-gradient(90deg, var(--nm-line-main), var(--nm-line-degraded), var(--nm-line-down))" }} /> : <span className={`nm-line-swatch is-${option.id}`} aria-hidden="true" />}
                  <span>{option.label}</span>
                  <span className="nm-count">{filterCounts[option.id]}</span>
                </button>
              ))}
            </div>
          ) : null}
          {/* 图例：手机上默认收成一个「图例」小条（四种线的小色条 + 两个字），点开才是 2×2 带条数的那张；
              展开的格子排在小条上面，小条钉在原地不跟着跑 */}
          <div className={`nm-legend nm-glass nm-reserved${compactChrome ? " is-compact" : ""}${compactChrome && legendOpen ? " is-open" : ""}`} role="group" aria-label="图例">
            {!compactChrome || legendOpen ? (
              <div className="nm-legend-grid" id="nm-legend-grid">
                {LINE_KINDS.map((kind) => (
                  <span key={kind} className="nm-legend-item"><i className={`nm-line-swatch is-${kind}`} aria-hidden="true" />{LINE_KIND_LABELS[kind]}<span className="nm-count">{model.lines[kind]}</span></span>
                ))}
              </div>
            ) : null}
            {compactChrome ? (
              <button type="button" className="nm-legend-toggle" aria-expanded={legendOpen} aria-controls="nm-legend-grid" onClick={() => setLegendOpen((open) => !open)}>
                <span className="nm-legend-dots" aria-hidden="true">{LINE_KINDS.map((kind) => <i key={kind} className={`nm-line-swatch is-${kind}`} />)}</span>
                图例
                <svg className="nm-legend-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>
              </button>
            ) : null}
          </div>
          <div className={`nm-toast nm-glass${toastText ? " is-show" : ""}`} role="status" aria-live="polite">{toastText}</div>
        </div>
        <NetworkMapSheet snap={snap} onSnapChange={setSnap} rail={rail} open={panelOpen} containerHeight={containerHeight} reduceMotion={reduceMotion} head={head} viewKey={viewKey}>
          {body}
        </NetworkMapSheet>
      </div>
    </div>
  );
}
