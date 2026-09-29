import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";

import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";
import type { NetworkMapCameraApi } from "@/components/network/NetworkMapCanvas";
import { NetworkMapSheet } from "@/components/network/NetworkMapSheet";
import { LinkDetailView, NodeDetailView, OverviewView, Pill, SheetHead, TargetDetailView, linkHeadTitle, nodeHeadSubtitle } from "@/components/network/NetworkMapSheetViews";
import "@/components/network/networkMap.css";
import { useTheme } from "@/contexts/ThemeContext";
import { buildNetworkMapAlerts, type NetworkMapAlert } from "@/features/network/networkMapAlerts";
import { useNetworkMapPageModel } from "@/features/network/networkMapModel";
import {
  RAIL_MIN_WIDTH,
  focusForLink,
  focusForNode,
  focusForTarget,
  mapPaddingForSheet,
  overviewHeadline,
  type MapFocus,
  type MapSheetView,
  type SheetSnap,
} from "@/features/network/networkMapPageState";
import { summarizeHostSeries, summarizeLatencySeries, sumTraffic } from "@/features/network/networkMapSeries";
import { copyTextToClipboard } from "@/lib/clipboard";
import { trpc } from "@/lib/trpc";
import { hostNeedsAgentUpgrade } from "@shared/fxpRuntime";
import {
  NETWORK_MAP_AMAP_TERMS_NOTE,
  NETWORK_MAP_BASE_LAYERS,
  NETWORK_MAP_BASE_LAYER_ORDER,
  NETWORK_MAP_LAYER_STORAGE_KEY,
  resolveNetworkMapBaseLayer,
  type NetworkMapBaseLayerId,
} from "@shared/networkMapBaseLayers";
import { describeNetworkHealth } from "@shared/networkHealth";
import { AGENT_VERSION } from "@shared/versions";

/**
 * 网络地图整页（/map）：把「主机 → 隧道 → 落地」放到真实地理位置上看。
 *
 * 地图引擎（MapLibre）单独一个包、lazy 进来；这页自己只管状态：底图、抽屉档位、
 * 当前视图、聚焦集合，以及点开详情时才取的那几条序列。模型和首页那块示意图共用
 * （features/network/networkMapModel），告警从模型里推（networkMapAlerts）。
 *
 * 手机上抽屉从底下升起、地图留白跟着抽屉走；≥900px 抽屉是右侧 400px 栏。
 */

const NetworkMapCanvas = lazy(() => import("@/components/network/NetworkMapCanvas"));

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => (typeof window !== "undefined" ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

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

function readStoredLayer(): unknown {
  try { return window.localStorage.getItem(NETWORK_MAP_LAYER_STORAGE_KEY); } catch { return null; }
}

function Icon({ name }: { name: "layers" | "fit" }) {
  if (name === "layers") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 8 12 13l9.5-5L12 3z" /><path d="m2.5 12.5 9.5 5 9.5-5" /><path d="m2.5 17 9.5 5 9.5-5" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>;
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

  // ---- 底图：记住的优先，默认跟面板主题 ----
  const [baseLayer, setBaseLayer] = useState<NetworkMapBaseLayerId>(() => resolveNetworkMapBaseLayer(readStoredLayer(), resolvedTheme));
  const [layerMenuOpen, setLayerMenuOpen] = useState(false);
  const layerMenuRef = useRef<HTMLDivElement | null>(null);
  const layerButtonRef = useRef<HTMLButtonElement | null>(null);
  const chooseLayer = (id: NetworkMapBaseLayerId) => {
    setBaseLayer(id);
    setLayerMenuOpen(false);
    try { window.localStorage.setItem(NETWORK_MAP_LAYER_STORAGE_KEY, id); } catch { /* 存不了就下次再默认 */ }
  };
  useEffect(() => {
    if (!layerMenuOpen) return undefined;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (layerMenuRef.current?.contains(target) || layerButtonRef.current?.contains(target)) return;
      setLayerMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [layerMenuOpen]);
  const skin = NETWORK_MAP_BASE_LAYERS[baseLayer].skin;

  // ---- 数据 ----
  const model = useNetworkMapPageModel({ enabled: !!user, withTargets: isAdmin });
  const alerts = useMemo(() => buildNetworkMapAlerts(model), [model]);
  const [showFlows, setShowFlows] = useState(true);
  const flowsOn = isAdmin && showFlows;

  // ---- 抽屉 / 视图 / 聚焦 ----
  const [snap, setSnap] = useState<SheetSnap>("peek");
  const [view, setView] = useState<MapSheetView>({ view: "overview" });
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [toastText, setToastText] = useState<string | null>(null);
  const [mapUnavailable, setMapUnavailable] = useState(false);
  const toastTimer = useRef<number | null>(null);
  const toast = useCallback((text: string) => {
    setToastText(text);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastText(null), 2400);
  }, []);
  const cameraRef = useRef<NetworkMapCameraApi | null>(null);
  const pendingCamera = useRef<(() => void) | null>(null);
  const padding = useMemo(() => mapPaddingForSheet(snap, containerHeight, rail), [snap, containerHeight, rail]);
  // 相机动作排在这次渲染之后：先让抽屉的新高度通过 setPadding 告诉地图（画布的 effect 先跑），再飞
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
    if (options.fly !== false) queueCamera((api) => { const at = api.hostLngLat(hostId); if (at) api.flyTo(at, Math.max(api.getZoom(), 7)); });
  };
  const openLink = (tunnelId: number, options: { fly?: boolean; focus?: boolean } = {}) => {
    const link = model.links.find((item) => item.id === tunnelId);
    setView({ view: "link", id: tunnelId });
    raiseSheet();
    if (options.focus !== false) setFocus(focusForLink(model, tunnelId));
    if (options.fly !== false && link) queueCamera((api) => {
      const points = link.path.map((id) => api.hostLngLat(id)).filter((point): point is [number, number] => !!point);
      api.fitPoints(points, 7.5);
    });
  };
  const openTarget = (key: string) => {
    setView({ view: "target", id: key });
    raiseSheet();
    setFocus(focusForTarget(model, key));
    queueCamera((api) => { const at = api.targetLngLat(key); if (at) api.flyTo(at, Math.max(api.getZoom(), 6)); });
  };
  const backToOverview = () => {
    setView({ view: "overview" });
    setFocus(null);
  };
  const clearFocus = () => {
    setFocus(null);
    setView({ view: "overview" });
    queueCamera((api) => api.fitAll());
  };
  const focusAlert = (alert: NetworkMapAlert) => {
    setFocus({ ...alert.focus, label: alert.title, severity: alert.severity });
    if (alert.open.view === "link") openLink(Number(alert.open.id), { fly: false, focus: false });
    else if (alert.open.view === "target") { setView({ view: "target", id: String(alert.open.id) }); raiseSheet(); }
    else openNode(Number(alert.open.id), { fly: false, focus: false });
    queueCamera((api) => {
      const points = [
        ...alert.focus.hosts.map((id) => api.hostLngLat(id)),
        ...alert.focus.targets.map((key) => api.targetLngLat(key)),
      ].filter((point): point is [number, number] => !!point);
      api.fitPoints(points, 7.2);
    });
  };

  // 点开的东西没了（被删了、权限变了）就回总览
  useEffect(() => {
    if (view.view === "node" && !model.nodes.some((node) => node.id === view.id)) setView({ view: "overview" });
    if (view.view === "link" && !model.links.some((link) => link.id === view.id)) setView({ view: "overview" });
    if (view.view === "target" && !model.targets.some((target) => target.key === view.id)) setView({ view: "overview" });
  }, [model, view]);

  // ---- 页面不可见时停掉流动光点 ----
  const [paused, setPaused] = useState(() => typeof document !== "undefined" && document.visibilityState !== "visible");
  useEffect(() => {
    const onVisibility = () => setPaused(document.visibilityState !== "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // ---- 高德拉不下来：切一次暗黑网格，不写进 localStorage（网络回来了还用用户选的） ----
  const onRasterError = useCallback(() => {
    setBaseLayer("dark");
    toast("高德底图加载失败，已切到暗黑网格");
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

  // ---- 抽屉内容 ----
  const headline = overviewHeadline(model, alerts.length);
  const currentNode = view.view === "node" ? model.nodes.find((node) => node.id === view.id) : undefined;
  const currentLink = view.view === "link" ? model.links.find((link) => link.id === view.id) : undefined;
  const currentTarget = view.view === "target" ? model.targets.find((target) => target.key === view.id) : undefined;
  const healthTone = (health: string) => {
    const token = describeNetworkHealth(health as any).token;
    return token === "healthy" ? "ok" : token === "warn" || token === "path" ? "warn" : token === "down" ? "down" : "standby";
  };
  let head: React.ReactNode;
  let body: React.ReactNode;
  if (currentNode) {
    const canUpgrade = isAdmin && hostNeedsAgentUpgrade(currentNode, AGENT_VERSION);
    head = <SheetHead onBack={backToOverview} title={`${currentNode.emoji ? `${currentNode.emoji} ` : ""}${currentNode.name}`} subtitle={nodeHeadSubtitle(currentNode, model)} trailing={<Pill tone={healthTone(currentNode.health)}>{currentNode.isOnline ? "在线" : currentNode.lastHeartbeat ? "离线" : "未接入"}</Pill>} />;
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
    head = <SheetHead onBack={backToOverview} title={linkHeadTitle(currentLink, model.nodes)} subtitle={`${currentLink.name} · ${currentLink.modeLabel}`} trailing={<Pill tone={healthTone(currentLink.health)}>{describeNetworkHealth(currentLink.health).label}</Pill>} />;
    body = (
      <LinkDetailView
        model={model}
        link={currentLink}
        latency={latency}
        latencyLoading={latencyQuery.isLoading}
        latencyError={latencyQuery.error ? "看不到这条隧道的延迟历史" : null}
        traffic={traffic}
        onDiagnose={() => testMutation.mutate({ id: currentLink.id })}
        diagnosing={testMutation.isPending}
        onOpenNode={(id) => openNode(id)}
      />
    );
  } else if (currentTarget) {
    head = <SheetHead onBack={backToOverview} title={`${currentTarget.emoji ? `${currentTarget.emoji} ` : ""}${currentTarget.city} · 落地目标`} subtitle={currentTarget.address} trailing={<Pill tone={healthTone(currentTarget.health)}>{currentTarget.health === "healthy" ? "规则在跑" : describeNetworkHealth(currentTarget.health).label}</Pill>} />;
    body = <TargetDetailView model={model} target={currentTarget} onOpenLink={(id) => openLink(id)} onOpenNode={(id) => openNode(id)} />;
  } else {
    head = (
      <SheetHead
        title={<>{headline.main}{headline.attention ? <span style={{ color: "var(--nm-warn)" }}> · {headline.attention}</span> : null}</>}
        subtitle={model.loading ? "正在读取主机和线路…" : model.error ? "有些数据没读到，看到的可能不完整" : "点主机或线路看详情 · 点告警会飞过去"}
      />
    );
    body = <OverviewView model={model} alerts={alerts} onAlert={focusAlert} onOpenNode={(id) => openNode(id)} onOpenLink={(id) => openLink(id)} baseLayerAmap={NETWORK_MAP_BASE_LAYERS[baseLayer].amap} />;
  }
  const viewKey = view.view === "overview" ? "overview" : `${view.view}:${view.id}`;

  const legend = [
    { key: "healthy", label: "正常", count: model.legend.healthy, color: "var(--nm-link)" },
    { key: "degraded", label: "降级", count: model.legend.degraded, color: "var(--nm-warn)" },
    { key: "down", label: "中断", count: model.legend.down, color: "var(--nm-down)" },
    { key: "standby", label: "停用", count: model.legend.standby, color: "var(--nm-standby)" },
  ].filter((item) => item.count > 0);

  return (
    <div
      ref={frameRef}
      className="fx-netmap"
      data-skin={skin}
      style={frame ? { marginLeft: frame.marginLeft, width: frame.width, height: frame.height } : { height: "70vh" }}
    >
      <div className="nm-layout">
        <div ref={mapWrapRef} className="nm-map-wrap">
          <Suspense fallback={<div className="nm-map-fallback">正在加载地图引擎…</div>}>
            <NetworkMapCanvas
              model={model}
              baseLayer={baseLayer}
              focus={focus}
              showFlows={flowsOn}
              padding={padding}
              reduceMotion={reduceMotion}
              paused={paused}
              onSelectNode={(id) => openNode(id)}
              onSelectLink={(id) => openLink(id)}
              onSelectTarget={openTarget}
              onSelectCluster={() => { if (!rail && snap !== "peek") setSnap("peek"); }}
              onMapClick={() => { if (layerMenuOpen) { setLayerMenuOpen(false); return; } if (!rail && snap !== "peek") setSnap("peek"); }}
              onRasterError={onRasterError}
              onUnavailable={() => setMapUnavailable(true)}
              onReady={(api) => { cameraRef.current = api; }}
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
          <div className="nm-overlay-tl">
            <h1 className="nm-chip nm-title">网络地图</h1>
            {legend.map((item) => <span key={item.key} className="nm-chip"><span className="nm-dot" style={{ background: item.color }} aria-hidden="true" />{item.label} {item.count}</span>)}
            {isAdmin ? (
              <button type="button" className="nm-chip nm-toggle" aria-pressed={showFlows} onClick={() => setShowFlows((value) => !value)} title="把规则的落地目标画出来，从出口拉一条细虚线过去">
                <span className="nm-dot" style={{ background: "var(--nm-standby)", opacity: 0.9 }} aria-hidden="true" />落地流向
              </button>
            ) : null}
          </div>
          <div className={`nm-focus-mask${focus ? " is-show" : ""}`} aria-hidden="true" />
          {focus ? (
            <button type="button" className="nm-focus-exit" onClick={clearFocus}>
              <span className="nm-sev" style={{ background: focus.severity === "error" ? "var(--nm-down)" : focus.severity === "warning" ? "var(--nm-warn)" : "var(--nm-accent)" }} aria-hidden="true" />
              <span className="nm-text">退出聚焦 · {focus.label}</span>
              <span aria-hidden="true">✕</span>
            </button>
          ) : null}
          <div className="nm-fabs">
            <button ref={layerButtonRef} type="button" className={`nm-fab${layerMenuOpen ? " is-active" : ""}`} aria-label="切换底图" aria-expanded={layerMenuOpen} onClick={() => setLayerMenuOpen((open) => !open)}><Icon name="layers" /></button>
            <button type="button" className="nm-fab" aria-label="回到全局视图" onClick={clearFocus}><Icon name="fit" /></button>
          </div>
          {layerMenuOpen ? (
            <div ref={layerMenuRef} className="nm-layer-menu" role="menu" aria-label="底图">
              <div className="nm-menu-title">底图</div>
              {NETWORK_MAP_BASE_LAYER_ORDER.map((id) => {
                const layer = NETWORK_MAP_BASE_LAYERS[id];
                return (
                  <button key={id} type="button" role="menuitemradio" aria-checked={baseLayer === id} aria-pressed={baseLayer === id} className="nm-layer-opt" onClick={() => chooseLayer(id)}>
                    <span className={`nm-swatch ${id}`} aria-hidden="true" />
                    <span><b>{layer.label}</b><small>{layer.hint}</small></span>
                  </button>
                );
              })}
              <div className="nm-menu-foot">{NETWORK_MAP_AMAP_TERMS_NOTE}</div>
            </div>
          ) : null}
          <div className={`nm-toast${toastText ? " is-show" : ""}`} role="status" aria-live="polite">{toastText}</div>
        </div>
        <NetworkMapSheet snap={snap} onSnapChange={setSnap} rail={rail} containerHeight={containerHeight} reduceMotion={reduceMotion} head={head} viewKey={viewKey}>
          {body}
        </NetworkMapSheet>
      </div>
    </div>
  );
}
