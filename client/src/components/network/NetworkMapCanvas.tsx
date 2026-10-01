import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";

import { INSET_MAX_ZOOM_OUT, MINI_CAP_MIN_ARC_PX, MINI_FIT_INSET_PX, MINI_FIT_MAX_ZOOM, groupPlaceLabel, insetLabelArea, miniGroupLayoutOptions, miniMinZoom, pickInsetZoom, placeInsetLabels, placeLabelBoxes, shouldRefit, type InsetLayoutReport, type InsetZoomCandidate, type LabelItem, type MiniFitTrigger, type MiniLayoutGroup, type MiniLayoutReport } from "@/features/network/networkMapMini";
import { countryLabelAnchors, countryLabelText } from "@/features/network/countryLabels";
import { hostsForFilter, lineVisible, nodeLatency, nodeTone, type LineFilter, type LineKind, type NodeTone } from "@/features/network/networkMapLines";
import type { NetworkMapModel, NetworkMapTarget } from "@/features/network/networkMapModel";
import { isClusterDimmed, isFlowDimmed, isHostDimmed, isRouteDimmed, isTargetDimmed, isTunnelDimmed, type MapFocus, type MapPadding } from "@/features/network/networkMapPageState";
import { wgs84ToGcj02 } from "@shared/gcj02";
import { NETWORK_MAP_BASE_LAYERS, type NetworkMapBaseLayerId, type NetworkMapSkin } from "@shared/networkMapBaseLayers";
import { advanceCometPhase, buildCometPath, cometPeriodMs, mercatorUnitsPerPixel, pointAt, type CometPath } from "@shared/networkMapComet";
import { boundsForPoints, computeMapLayout, fitViewToBoxes, greatCircleArc, unionBox, type FitItem, type LayoutPoint, type LngLat, type MapLayout, type MapLayoutOptions, type PixelBox, type PixelPoint } from "@shared/networkMapGeometry";
import { describeNetworkHealth, type NetworkHealth } from "@shared/networkHealth";

import { registerEarthTiles } from "./earthTiles";
import { readCssColor } from "./mapCharts";
import {
  NETWORK_MAP_LAYERS,
  NETWORK_MAP_SOURCES,
  baseLayerPaintPatch,
  buildNetworkMapStyle,
  kindColorExpression,
  linkGradient,
  rasterSourceIds,
  type NetworkMapBaseColors,
  type NetworkMapLineColors,
} from "./networkMapStyle";

/**
 * 网络地图的画布：MapLibre 只在这一个文件里出现，页面用 lazy() 动态引入它 ——
 * 地图引擎有几百 KB，不该跟着抽屉、告警这些一起打进首屏的包，也方便把抽屉那些
 * 视图在 node 里用 renderToStaticMarkup 测（那里没有 WebGL）。
 *
 * 它是「无状态的画家」：模型、聚焦集合、底图、留白全由页面传进来，自己只管
 * 把这些画到图上；点了什么通过回调告诉页面。相机操作（飞过去、框住几点）通过
 * onReady 交出去一个小 API。
 *
 * 高德底图下每个点先过 WGS-84 → GCJ-02（shared/gcj02.ts），离线底图（地球图、Natural Earth 国界）
 * 都是 WGS-84 不转 —— 所以坐标转换在这里做、按当前底图做，模型里存的永远是原始坐标。
 *
 * 画法是「夜里的网络运维大屏」：主机是一圈发光的环（深色的芯、外面一圈柔光），颜色说状态 ——
 * 正常绿、枢纽亮蓝、落地紫、降级琥珀、中断红、没接入灰；除了颜色，环的样子也说健康（降级外面
 * 多一圈虚线、中断中间一个叉、没接入是半透明的空环），色弱的人也分得清。名字和延迟写在环旁边。
 * 线是霓虹：宽而模糊的光 + 细而亮的芯，四类线各一种颜色（networkMapLines），主线路上有两三颗
 * 错开的光点往出口流，中断的线正中一个 ⊗。
 *
 * 三种用法（variant）：
 *   page  /map 整页：能拖能缩，缩小时聚簇，有簇 pill、看不到的主机的灰线。
 *   mini  首页那块卡片的主图：能拖能捏合缩放、双击放大（滚轮不缩：滚轮要留给页面滚动，
 *         卡片角上有 + / − 按钮），每台主机画在真实坐标上，圆盘会压在一起的（28px 内）并成
 *         一枚叠起来的 marker；主机的圆盘小一号、不写备注；框住所有主机后按 marker 真正占的
 *         像素再精确框一遍，谁都不会被边裁掉；用户拖过 / 缩过之后（userMoved）就不再自动框，
 *         直到卡片叫 fitAll（「回到全览」）。把分组、占用情况报给卡片（onMiniLayout），卡片
 *         据此摆局部放大的小窗。点主机 / 线只回调，不开整页 —— 卡片自己决定提示什么。
 *   inset 卡片里局部放大的小窗：和 mini 一样的画法，不能拖，只框 fitHostIds 那几台（最多 9 级）；
 *         窗里还叠着的照样并成一枚小 pill（画在真实组心，不错开）。名字以窗为边界摆，摆不干净的
 *         藏起来（点圆盘的提示里有名字）；不在框里的主机圆盘露不全就不画。框好之后把藏了几个
 *         名字报给卡片（onInsetLayout），手机上卡片据此试着把窗放大一号。
 * 同一个画家，不另写一份。
 */

export type NetworkMapCameraApi = {
  flyTo(lngLat: LngLat, zoom: number): void;
  fitPoints(points: LngLat[], maxZoom?: number): void;
  /** 框住全部；小图上同时清掉 userMoved（这是用户点了「回到全览」，或者首次 / 卡片变宽 / 主机集合变了） */
  fitAll(): void;
  /** 小图角上的 + / −：放大 / 缩小一级，算用户动过图 */
  zoomBy(delta: number): void;
  /** 一台主机 / 一个目标当前画在哪（原始坐标；没画出来是 null） */
  hostLngLat(hostId: number): LngLat | null;
  targetLngLat(key: string): LngLat | null;
  getZoom(): number;
};

export type NetworkMapCanvasVariant = "page" | "mini" | "inset";

export type NetworkMapCanvasProps = {
  model: NetworkMapModel;
  baseLayer: NetworkMapBaseLayerId;
  /** 界面皮肤（页面按底图和面板主题算好的）：变了要从 CSS 重新读一遍底图和线的颜色 */
  skin: NetworkMapSkin;
  focus: MapFocus | null;
  showFlows: boolean;
  padding: MapPadding;
  reduceMotion: boolean;
  /** 页面不可见 / 地图被盖住时停掉流动光点 */
  paused: boolean;
  /** 整页、首页小图的主图，还是小图里的放大小窗（默认整页） */
  variant?: NetworkMapCanvasVariant;
  /** inset：只框这几台主机（别的照画，只是在窗外） */
  fitHostIds?: number[];
  /** mini：每次布局完把分组和占用情况报给卡片，卡片据此摆小窗 */
  onMiniLayout?: (report: MiniLayoutReport) => void;
  /** inset：框好之后报一次窗多大、藏了几个要框的主机的名字 */
  onInsetLayout?: (report: InsetLayoutReport) => void;
  /** mini：卡片把小窗摆在了这些地方，延迟胶囊沿着弧线挪开，别被小窗盖住 */
  avoidBoxes?: PixelBox[];
  /** 主线路上流动的光点（默认开；减少动态时不画） */
  comets?: boolean;
  /** 画成亮蓝、光晕大一圈的那台（pickHubNode） */
  hubHostId?: number | null;
  /** 只看某一类线（整页的「筛选」）；别的线不画，不挂在看得见的线上的主机压暗 */
  lineFilter?: LineFilter;
  onSelectNode: (hostId: number) => void;
  onSelectLink: (tunnelId: number) => void;
  onSelectTarget: (key: string) => void;
  /** 点了簇 / 组：整页飞过去放大；小图上带着组员 id 跳整页 */
  onSelectCluster: (center: LngLat, zoom: number, hostIds: number[]) => void;
  onMapClick: () => void;
  /** 高德瓦片拉不下来（内网、被墙、断网）时叫一次 */
  onRasterError: () => void;
  /** 建不出 WebGL 上下文（远程桌面、老浏览器、被禁用了硬件加速）：页面画兜底文案 */
  onUnavailable: () => void;
  onReady: (api: NetworkMapCameraApi) => void;
};

const COUNTRIES_URL = "/globe/ne_110m_admin_0_countries.geojson";

/**
 * 简洁底图上国家名的标注点：和底图用的是同一份国界文件（浏览器已经缓存了，MapLibre 也是拉它），
 * 第一次要用时拉一次、全页共用。拉不下来就不写国家名，图照画。
 */
let countryAnchorsPromise: Promise<Map<string, LngLat>> | null = null;
function loadCountryAnchors(): Promise<Map<string, LngLat>> {
  if (!countryAnchorsPromise) {
    countryAnchorsPromise = fetch(COUNTRIES_URL)
      .then((response) => (response.ok ? response.json() : null))
      .then((json) => countryLabelAnchors(json) as Map<string, LngLat>)
      .catch(() => new Map<string, LngLat>());
  }
  return countryAnchorsPromise;
}
/** 放大到这一级以上不写国家名：标注点早就在屏幕外，留着的只会是半个国家名压在城市上 */
const COUNTRY_LABEL_MAX_ZOOM = 6;

/** 框住几个点时在地图留白之外再让出的边：marker 下面的名字和备注有百来像素宽，贴边会被裁掉半截 */
const FIT_PADDING = { top: 36, bottom: 36, left: 64, right: 64 };
/** 小图：fitBounds 只是粗放一下，随后按 marker 真正占的像素精确框（settleFit），所以留白不用算得很准 */
const MINI_FIT_PADDING = { top: 34, bottom: 44, left: 52, right: 52 };
/** 小窗只有一百多像素宽，主图那份留白比窗还大，fitBounds 会直接放弃；小窗的粗放留白按窗的尺度来 */
const INSET_FIT_PADDING = { top: 30, bottom: 20, left: 20, right: 20 };
/** 小窗按圆盘框好之后，为了给名字腾地方往外试的几档（级）：每档都摆一遍名字，挑名字摆得最好的那档 */
const INSET_ZOOM_OUT_STEPS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5];
/** 精确框住时 marker 离容器边至少这么远；小窗顶上还有一条标题 */
const FIT_INSET = { mini: { top: MINI_FIT_INSET_PX, right: MINI_FIT_INSET_PX, bottom: MINI_FIT_INSET_PX, left: MINI_FIT_INSET_PX }, inset: { top: 26, right: MINI_FIT_INSET_PX, bottom: MINI_FIT_INSET_PX, left: MINI_FIT_INSET_PX } };
/**
 * 小图上一台主机占的盒子半径（摆名字、精确框住、并组都按它）：14px 的环加一圈光，外接一个 20px 的方块；
 * 名字离锚点 10px —— 正好贴着这个方块（networkMap.css 的 .nm-mini .nm-mk-name 的 top / bottom 必须是同一个数）。
 */
const MINI_DISC_R = 10;
const MINI_LABEL_GAP = 10;

/** 一跳的两端在屏幕上至少隔这么远才挂延迟小牌子 / 中断的 ⊗（小图的阈值在 features/network/networkMapMini） */
const CAP_MIN_ARC_PX = 90;

/** 一帧最多按这么多毫秒推进：切回标签页时不让光点一下跳半圈 */
const COMET_MAX_FRAME_MS = 100;
/** 一条路上同时流着几颗光点：屏幕上短的两颗，长的三颗，均匀错开 */
const PARTICLES_SHORT = 2;
const PARTICLES_LONG = 3;
const PARTICLES_LONG_PX = 220;

const FALLBACK_COLORS: NetworkMapLineColors = { main: "#3b82f6", backup: "#cbd5e1", degraded: "#f59e0b", down: "#ef4444", flow: "#a855f7", particle: "#e0f2fe" };
const FALLBACK_BASE: NetworkMapBaseColors = { water: "#050b16", land: "#0c1625", border: "rgba(56,189,248,0.22)", graticule: "rgba(34,211,238,0.08)" };

/** 状态 → 落地目标、组、延迟牌子用的那几档 CSS 类 */
function healthClass(health: NetworkHealth) {
  const token = describeNetworkHealth(health).token;
  return token === "healthy" ? "is-ok" : token === "warn" || token === "path" ? "is-warn" : token === "down" ? "is-down" : "is-standby";
}

/** 一组里最该被看到的那个颜色：中断 > 降级 > 没接入 > 正常 */
const TONE_RANK: Record<NodeTone, number> = { down: 0, warn: 1, standby: 2, ok: 3, hub: 4 };

function readColors(container: HTMLElement | null): NetworkMapLineColors {
  return {
    main: readCssColor(container, "--nm-line-main", FALLBACK_COLORS.main),
    backup: readCssColor(container, "--nm-line-backup", FALLBACK_COLORS.backup),
    degraded: readCssColor(container, "--nm-line-degraded", FALLBACK_COLORS.degraded),
    down: readCssColor(container, "--nm-line-down", FALLBACK_COLORS.down),
    flow: readCssColor(container, "--nm-target", FALLBACK_COLORS.flow),
    particle: readCssColor(container, "--nm-particle", FALLBACK_COLORS.particle),
  };
}

/** 自绘底图的颜色也是 CSS 令牌，MapLibre 不认 var()，读出来再给它 */
function readBaseColors(container: HTMLElement | null): NetworkMapBaseColors {
  return {
    water: readCssColor(container, "--nm-water", FALLBACK_BASE.water),
    land: readCssColor(container, "--nm-land", FALLBACK_BASE.land),
    border: readCssColor(container, "--nm-border-line", FALLBACK_BASE.border),
    graticule: readCssColor(container, "--nm-graticule", FALLBACK_BASE.graticule),
  };
}

function el(html: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html.trim();
  return wrapper.firstElementChild as HTMLElement;
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char] || char);
}

/** 主机名下面那行：到这台机的延迟，掉线写「离线」、没接入写「未接入」，入口机不写 */
function hostSubline(tone: NodeTone, latency: number | null): string {
  if (tone === "down") return "离线";
  if (tone === "standby") return "未接入";
  return latency === null ? "" : `${Math.round(latency)} ms`;
}

/** 中断的线正中那个 ⊗ */
const BREAK_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" /><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" /></svg>`;

type HostMarkerEntry = { marker: Marker; element: HTMLElement; signature: string };
type TargetMarkerEntry = { marker: Marker; element: HTMLElement; signature: string };
/** 线上的小牌子：延迟（`t:<隧道>`）或中断的 ⊗（`b:<线的 key>`） */
type CapEntry = { marker: Marker; element: HTMLElement; button: HTMLButtonElement; line: LineRef };
/** 一条线（隧道或线路组的一条路径）的身份：聚焦、筛选、点击都按它找 */
type LineRef = { tunnelId: number; routeKey: string | null; kind: LineKind; entryHostId: number };

type Live = {
  props: NetworkMapCanvasProps;
  map: MapLibreMap | null;
  loaded: boolean;
  colors: NetworkMapLineColors;
  hostMarkers: Map<number, HostMarkerEntry>;
  targetMarkers: Map<string, TargetMarkerEntry>;
  clusterMarkers: Array<{ marker: Marker; members: Array<{ kind: "host"; id: number } | { kind: "target"; key: string }>; center: LngLat; label: string }>;
  capMarkers: Map<string, CapEntry>;
  stubMarkers: Map<number, Marker>;
  /** 有主机的国家写一个国名（按国家代码复用） */
  countryMarkers: Map<string, Marker>;
  layout: MapLayout | null;
  linkFeatureIds: Array<{ fid: string } & LineRef>;
  flowFeatureIds: Array<{ fid: string; targetKey: string; ruleIds: number[] }>;
  waypointFeatureIds: Array<{ fid: string } & LineRef>;
  /** 主线路上流动的光点：每条路一组（跳与跳之间断开时拆成几段各一组） */
  comets: Array<{ key: string; line: LineRef; path: CometPath; periodMs: number; count: number }>;
  /** 光点的相位按 key 记着，relayout 重算路径时接着跑，不从头来 */
  cometPhase: Map<string, number>;
  cometLast: number;
  /** 上一帧有没有往光点源里写过东西：停下来时要清一次，别留几颗不动的点 */
  cometDrawn: boolean;
  didInitialFit: boolean;
  /** 小图上一次框住的是哪些点：主机集合变了才重新框 */
  fitSignature: string;
  /** 小图 / 小窗：上一次布局里每个 marker 占的像素（精确框住、报给卡片都用它） */
  fitItems: FitItem[];
  keepOut: PixelBox[];
  /** 小图：角上的小标签、+ / − 按钮占的盒子 */
  reserved: PixelBox[];
  /** 小窗：要框的主机 / 组里有几个名字摆不下藏起来了 */
  hiddenLabels: number;
  /** 小窗精确框住的第一步：只按圆盘 / pill 框，名字不算 */
  discFit: boolean;
  /** 小窗试几档缩放时：按「摆不干净就藏」摆名字，数得出每档藏几个 */
  labelProbe: boolean;
  /** 小窗：要框的那几台现在画成了几枚 marker、各占哪（缩小时有没有又并起来、圆盘有没有出窗） */
  framedBodies: PixelBox[];
  arcPx: PixelPoint[];
  miniGroups: MiniLayoutGroup[];
  /** 正在精确框住：中间几轮布局不报给卡片，收敛了报一次 */
  settling: boolean;
  /** 这次报告是框好之后报的（卡片这时才重新摆小窗） */
  settledReport: boolean;
  /** 小图：用户拖过 / 缩过、还没回到全览 —— 不再自动框，报给卡片显示「回到全览」 */
  userMoved: boolean;
  lastReport: string;
  rasterErrorReported: boolean;
  relayoutFrame: number;
  /** 光点动画的 rAF */
  animFrame: number;
};

export default function NetworkMapCanvas(props: NetworkMapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const liveRef = useRef<Live | null>(null);
  if (!liveRef.current) {
    liveRef.current = {
      props, map: null, loaded: false, colors: FALLBACK_COLORS,
      hostMarkers: new Map(), targetMarkers: new Map(), clusterMarkers: [], capMarkers: new Map(), stubMarkers: new Map(), countryMarkers: new Map(),
      layout: null, linkFeatureIds: [], flowFeatureIds: [], waypointFeatureIds: [], comets: [], cometPhase: new Map(), cometLast: 0, cometDrawn: false,
      didInitialFit: false, fitSignature: "", fitItems: [], keepOut: [], reserved: [], hiddenLabels: 0, discFit: false, labelProbe: false, framedBodies: [], arcPx: [], miniGroups: [], settling: false, settledReport: false, userMoved: false, lastReport: "", rasterErrorReported: false,
      relayoutFrame: 0, animFrame: 0,
    };
  }
  const live = liveRef.current;
  live.props = props;
  const variant = () => live.props.variant ?? "page";
  /** 小图的主图和小窗共用的「紧凑」画法：小圆盘、不写备注、不飞只跳、不能拖 */
  const compact = () => variant() !== "page";
  const isMini = () => variant() === "mini";
  const isInset = () => variant() === "inset";
  /** 小窗要框住的主机；主图是全部 */
  const framedHostIds = () => (isInset() && live.props.fitHostIds ? new Set(live.props.fitHostIds) : null);

  // ---- 坐标：底图决定转不转 ----
  const display = (lngLat: LngLat): LngLat => (NETWORK_MAP_BASE_LAYERS[live.props.baseLayer].amap ? wgs84ToGcj02(lngLat[0], lngLat[1]) : lngLat);

  const layoutPoints = (): LayoutPoint[] => {
    const { model, showFlows } = live.props;
    const points: LayoutPoint[] = [];
    for (const node of model.nodes) if (node.geo) points.push({ key: `h${node.id}`, lngLat: display([node.geo.lng, node.geo.lat]) });
    if (showFlows) for (const target of model.targets) if (target.geo) points.push({ key: `t:${target.key}`, lngLat: display([target.geo.lng, target.geo.lat]) });
    return points;
  };

  /** 小图要框住的点的集合（key 排序后拼起来）：变了才重新框，轮询回来同样的主机不动相机 */
  const fitSignature = () => `${(live.props.fitHostIds ?? []).join(",")}#${layoutPoints().map((point) => point.key).sort().join("|")}`;

  /** 错开成环的点：簇心加像素偏移换算回经纬度，线才能连到 marker 真正画的地方 */
  const displayLngLat = (key: string): LngLat | null => {
    const map = live.map;
    const position = live.layout?.pos[key];
    if (!map || !position) return null;
    if (position.offset[0] === 0 && position.offset[1] === 0) return position.lngLat;
    const point = map.project(position.lngLat as [number, number]);
    const lngLat = map.unproject([point.x + position.offset[0], point.y + position.offset[1]]);
    return [lngLat.lng, lngLat.lat];
  };

  // ---- marker 同步：按 id 复用元素，轮询回来的新模型只改变了的字，呼吸动画不会重新开始 ----
  const syncStaticMarkers = () => {
    const map = live.map;
    if (!map) return;
    const { model, showFlows } = live.props;
    const hub = live.props.hubHostId ?? null;
    const seenHosts = new Set<number>();
    for (const node of model.nodes) {
      if (!node.geo) continue;
      seenHosts.add(node.id);
      const tone = nodeTone(model, node.id, hub);
      const subline = hostSubline(tone, nodeLatency(model, node.id));
      const signature = [node.name, node.city, tone, subline].join("\u0001");
      let entry = live.hostMarkers.get(node.id);
      if (!entry) {
        const element = el(`<div class="nm-mk nm-mk-host" data-host="${node.id}"><button type="button" class="nm-mk-disc"><i class="nm-mk-pulse"></i><i class="nm-mk-glyph"></i></button><div class="nm-mk-name"><b class="nm-mk-city"></b><span class="nm-mk-lat"></span></div></div>`);
        const disc = element.querySelector(".nm-mk-disc") as HTMLButtonElement;
        disc.addEventListener("click", (event) => { event.stopPropagation(); live.props.onSelectNode(node.id); });
        const marker = new maplibregl.Marker({ element, anchor: "center" }).setLngLat(display([node.geo.lng, node.geo.lat])).addTo(map);
        entry = { marker, element, signature: "" };
        live.hostMarkers.set(node.id, entry);
      }
      if (entry.signature !== signature) {
        entry.signature = signature;
        const keep = ["is-hidden", "is-dim", "is-clipped"].filter((name) => entry!.element.classList.contains(name));
        entry.element.className = ["nm-mk", "nm-mk-host", `is-${tone}`, ...keep].join(" ");
        entry.element.dataset.tone = tone;
        const disc = entry.element.querySelector(".nm-mk-disc") as HTMLElement;
        disc.setAttribute("aria-label", [node.name, node.city !== node.name ? node.city : null, subline || null].filter(Boolean).join("，"));
        // 图上写城市（「东京」），主机名在抽屉、提示和读屏文字里
        (entry.element.querySelector(".nm-mk-city") as HTMLElement).textContent = node.city;
        const lat = entry.element.querySelector(".nm-mk-lat") as HTMLElement;
        lat.textContent = subline;
        lat.hidden = !subline;
      }
    }
    for (const [id, entry] of live.hostMarkers) {
      if (seenHosts.has(id)) continue;
      entry.marker.remove();
      live.hostMarkers.delete(id);
    }
    const seenTargets = new Set<string>();
    if (showFlows) {
      for (const target of model.targets) {
        if (!target.geo) continue;
        seenTargets.add(target.key);
        const signature = [target.city, target.health, target.address].join("\u0001");
        let entry = live.targetMarkers.get(target.key);
        if (!entry) {
          // 落地目标：紫色的环（和主机同一种画法，颜色说「这是落地」）
          const element = el(`<div class="nm-mk nm-mk-target"><button type="button" class="nm-mk-disc"><i class="nm-mk-glyph"></i></button><div class="nm-mk-name"><b class="nm-mk-city"></b><span class="nm-mk-lat"></span></div></div>`);
          const disc = element.querySelector(".nm-mk-disc") as HTMLButtonElement;
          disc.addEventListener("click", (event) => { event.stopPropagation(); live.props.onSelectTarget(target.key); });
          const marker = new maplibregl.Marker({ element, anchor: "center" }).setLngLat(display([target.geo.lng, target.geo.lat])).addTo(map);
          entry = { marker, element, signature: "" };
          live.targetMarkers.set(target.key, entry);
        }
        if (entry.signature !== signature) {
          entry.signature = signature;
          const keep = ["is-hidden", "is-dim"].filter((name) => entry!.element.classList.contains(name));
          entry.element.className = ["nm-mk", "nm-mk-target", healthClass(target.health), ...keep].join(" ");
          (entry.element.querySelector(".nm-mk-disc") as HTMLElement).setAttribute("aria-label", `落地节点 ${target.address}`);
          (entry.element.querySelector(".nm-mk-city") as HTMLElement).textContent = target.city;
          (entry.element.querySelector(".nm-mk-lat") as HTMLElement).textContent = target.health === "down" ? "中断" : "落地";
        }
      }
    }
    for (const [key, entry] of live.targetMarkers) {
      if (seenTargets.has(key)) continue;
      entry.marker.remove();
      live.targetMarkers.delete(key);
    }
    syncCountryLabels();
  };

  /**
   * 国家名：只给有主机（有坐标）的国家写一个，中文名，小而淡。小窗里不写（窗就一百多像素）。
   * 标注点要等国界文件到了才知道，所以是异步建的；建好立刻按当前视图判断显不显示。
   */
  const syncCountryLabels = () => {
    if (isInset()) return;
    const codes = new Map<string, string>();
    for (const node of live.props.model.nodes) {
      const code = node.geo && node.countryCode ? node.countryCode.toUpperCase() : "";
      if (code && !codes.has(code)) codes.set(code, node.city);
    }
    void loadCountryAnchors().then((anchors) => {
      const map = live.map;
      if (!map) return;
      for (const [code, marker] of live.countryMarkers) {
        if (codes.has(code) && anchors.has(code)) continue;
        marker.remove();
        live.countryMarkers.delete(code);
      }
      for (const code of codes.keys()) {
        const at = anchors.get(code);
        if (!at || live.countryMarkers.has(code)) continue;
        const element = el(`<div class="nm-mk nm-mk-country-shell"><div class="nm-mk-country is-off">${escapeHtml(countryLabelText(code))}</div></div>`);
        const marker = new maplibregl.Marker({ element, anchor: "center" }).setLngLat(at as [number, number]).addTo(map);
        // 排到所有 marker 前面（紧跟在画布后面）：万一和谁擦边，国名在底下；不能排到画布前面，会被画布盖住
        const canvas = map.getCanvas();
        if (canvas.parentElement === element.parentElement) canvas.after(element);
        live.countryMarkers.set(code, marker);
      }
      updateCountryLabels();
    });
  };

  /**
   * 整页上的名字（城市 + 延迟两行）：默认摆在环的右边；压到别的环、组、牌子、别人的名字或图上的控件
   * （.nm-reserved：标题、统计、工具栏、图例）时依次试左边、下面、上面；都不行就只留城市一行再试一次
   * 右边，还不行就不画（点开主机就有）。枢纽和出问题的先挑位置。量的是 DOM 里的真实位置。
   * 小图不走这里：那边有自己的摆法（placeCompactLabels）。
   */
  const updatePageLabels = () => {
    const map = live.map;
    if (!map || compact()) return;
    const container = map.getContainer();
    const frame = container.getBoundingClientRect();
    const scope = container.parentElement ?? container;
    const visible = (node: Element) => !(node as HTMLElement).closest(".is-hidden");
    const blockers: DOMRect[] = Array.from(container.querySelectorAll(".nm-mk-disc, .nm-mk-pill, .nm-mk-cap, .nm-mk-stub"))
      .filter(visible)
      .map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    for (const node of Array.from(scope.querySelectorAll(".nm-reserved"))) {
      if ((node as HTMLElement).closest(".nm-map")) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) blockers.push(rect);
    }
    const hit = (rect: DOMRect) => rect.left < frame.left + 2 || rect.top < frame.top + 2 || rect.right > frame.right - 2 || rect.bottom > frame.bottom - 2
      || blockers.some((other) => rect.left < other.right && other.left < rect.right && rect.top < other.bottom && other.top < rect.bottom);
    type Item = { element: HTMLElement; name: HTMLElement; rank: number };
    const items: Item[] = [];
    for (const entry of live.hostMarkers.values()) {
      const name = entry.element.querySelector(".nm-mk-name") as HTMLElement | null;
      if (!name || entry.element.classList.contains("is-hidden")) continue;
      const tone = (entry.element.dataset.tone as NodeTone) || "ok";
      items.push({ element: entry.element, name, rank: tone === "hub" ? -1 : TONE_RANK[tone] });
    }
    for (const entry of live.targetMarkers.values()) {
      const name = entry.element.querySelector(".nm-mk-name") as HTMLElement | null;
      if (name && !entry.element.classList.contains("is-hidden")) items.push({ element: entry.element, name, rank: 5 });
    }
    for (const cluster of live.clusterMarkers) {
      const element = cluster.marker.getElement();
      const name = element.querySelector(".nm-mk-name") as HTMLElement | null;
      if (name) items.push({ element, name, rank: 0 });
    }
    items.sort((a, b) => a.rank - b.rank);
    const SIDES = ["", "is-left", "is-below", "is-above"];
    for (const item of items) {
      const { name } = item;
      name.classList.remove("is-left", "is-below", "is-above", "is-off", "is-short");
      let placed: DOMRect | null = null;
      for (const pass of [false, true]) {
        name.classList.toggle("is-short", pass);
        for (const side of pass ? [""] : SIDES) {
          name.classList.remove("is-left", "is-below", "is-above");
          if (side) name.classList.add(side);
          const rect = name.getBoundingClientRect();
          if (!hit(rect)) { placed = rect; break; }
        }
        if (placed) break;
      }
      if (placed) blockers.push(placed);
      else { name.classList.remove("is-left", "is-below", "is-above", "is-short"); name.classList.add("is-off"); }
    }
  };

  /**
   * 国名显不显示：高德底图自己有地名，不写；放大到 6 级以上不写；压到主机、名字、延迟牌子、组、
   * 角上的控件或小窗的也不写 —— 国名是最不要紧的那个字，谁都不让它挡。量的是 DOM 里的真实位置。
   */
  const updateCountryLabels = () => {
    const map = live.map;
    if (!map || live.countryMarkers.size === 0) return;
    const show = !NETWORK_MAP_BASE_LAYERS[live.props.baseLayer].amap && map.getZoom() < COUNTRY_LABEL_MAX_ZOOM;
    const container = map.getContainer();
    const frame = container.getBoundingClientRect();
    const scope = container.parentElement ?? container;
    const blockers: DOMRect[] = [];
    if (show) {
      for (const node of Array.from(scope.querySelectorAll(".nm-mk-disc, .nm-mk-pill, .nm-mk-name, .nm-mk-cap, .nm-mk-stub, .nm-reserved, .nm-inset"))) {
        const element = node as HTMLElement;
        if (element.closest(".is-hidden, .is-clipped, .is-filtered, .nm-inset.is-off") || element.classList.contains("is-off")) continue;
        // 小窗里那张图的 marker 不算（整扇小窗已经算了一个盒子）
        if (!element.classList.contains("nm-inset") && element.closest(".nm-inset")) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) blockers.push(rect);
      }
    }
    for (const marker of live.countryMarkers.values()) {
      const label = marker.getElement().firstElementChild as HTMLElement | null;
      if (!label) continue;
      if (!show) { label.classList.add("is-off"); continue; }
      const rect = label.getBoundingClientRect();
      const pad = 3;
      const outside = rect.left < frame.left + 4 || rect.top < frame.top + 4 || rect.right > frame.right - 4 || rect.bottom > frame.bottom - 4;
      const blocked = blockers.some((other) => rect.left - pad < other.right && other.left < rect.right + pad && rect.top - pad < other.bottom && other.top < rect.bottom + pad);
      label.classList.toggle("is-off", outside || blocked);
    }
  };

  /**
   * project() 按给的经度投影，美国的 -118° 可能落在左边那份世界副本上（x 为负）；marker 自己会
   * 挪到离视口中心最近的一份（MapLibre 的 smartWrap），这里也挪过去，不然按负的 x 算出来的
   * 「贴边」是假的。
   */
  const viewProject = (map: MapLibreMap, lngLat: LngLat): PixelPoint => {
    const point = map.project(lngLat as [number, number]);
    const worldSize = 512 * 2 ** map.getZoom();
    const cx = map.getContainer().clientWidth / 2;
    return { x: point.x - Math.round((point.x - cx) / worldSize) * worldSize, y: point.y };
  };

  /**
   * 小图 / 小窗上名字的摆法（规则在 features/network/networkMapMini 的 placeLabelBoxes）：
   * 默认在圆盘下面，压到别的名字、圆盘、胶囊、角上的小标签或露出边时翻到上面、左右挪、
   * 缩小字号。量的是名字元素的真实宽度（它已经在 DOM 里）。顺手把每个 marker 真正占的
   * 像素记下来：精确框住（settleFit）和报给卡片摆小窗都用这一份。
   * 整页不做这个：那里缩小时会聚簇，名字很少撞。
   */
  const placeCompactLabels = (capsAt: Array<{ key: string; at: LngLat; line: LineRef }>) => {
    const map = live.map;
    const layout = live.layout;
    if (!map || !layout) return;
    const container = map.getContainer();
    const width = container.clientWidth;
    const height = container.clientHeight;
    const inset = isInset();
    // 小窗：名字以窗为边界（四边让出 8px）；框好之后摆不干净的藏起来 —— 窗不能拖，露出窗边的那截永远补不回来。
    // 精确框住的中间几轮还按「压得最少」摆，露出边的那点让 settleFit 缩一点补回来
    const area: PixelBox = inset ? insetLabelArea({ width, height }) : { x: 0, y: 0, w: width, h: height };
    const hideMode = inset && (!live.settling || live.labelProbe);
    const framed = framedHostIds();
    const fullyInside = (box: PixelBox) => box.x >= 0 && box.y >= 0 && box.x + box.w <= width && box.y + box.h <= height;
    const resetName = (name: HTMLElement) => {
      name.classList.remove("is-up", "is-tight", "is-off", "is-side");
      name.style.marginLeft = "";
    };
    type Entry = { key: string; name: HTMLElement; anchor: PixelPoint; body: PixelBox; gap: number; counts: boolean };
    const entries: Entry[] = [];
    for (const [id, entry] of live.hostMarkers) {
      entry.element.classList.remove("is-clipped");
      const position = layout.pos[`h${id}`];
      const name = entry.element.querySelector(".nm-mk-name") as HTMLElement | null;
      if (!position || !name) continue;
      // 并进组的主机不画自己的名字：把上一次的摆法清掉，散开时从头摆
      if (position.clusterId !== null) { resetName(name); continue; }
      const anchor = viewProject(map, position.lngLat);
      const at = { x: anchor.x + position.offset[0], y: anchor.y + position.offset[1] };
      const body = { x: at.x - MINI_DISC_R, y: at.y - MINI_DISC_R, w: MINI_DISC_R * 2, h: MINI_DISC_R * 2 };
      const counts = !framed || framed.has(id);
      // 小窗里路过的别的主机（东京在港粤的窗边）：圆盘露不全就整个不画 —— 半个盘卡在窗边像画坏了，
      // 线照样伸出窗外，它在主图上也看得见
      if (inset && !counts && !fullyInside(body)) {
        entry.element.classList.add("is-clipped");
        resetName(name);
        continue;
      }
      // 图外面老远的主机不参与摆名字：贴边的规则会把它的名字拖进图里来
      if (at.x < -60 || at.y < -60 || at.x > width + 60 || at.y > height + 60) {
        resetName(name);
        continue;
      }
      entries.push({ key: `h${id}`, name, anchor, body, gap: MINI_LABEL_GAP, counts });
    }
    for (const cluster of live.clusterMarkers) {
      const element = cluster.marker.getElement();
      element.classList.remove("is-clipped");
      const pill = element.querySelector(".nm-mk-pill") as HTMLElement | null;
      const name = element.querySelector(".nm-mk-name") as HTMLElement | null;
      if (!pill || !name) continue;
      const anchor = viewProject(map, cluster.center);
      const w = pill.offsetWidth || 50;
      const h = pill.offsetHeight || 18;
      const body = { x: anchor.x - w / 2, y: anchor.y - h / 2, w, h };
      const counts = !framed || cluster.members.some((member) => member.kind === "host" && framed.has(member.id));
      if (inset && !counts && !fullyInside(body)) {
        element.classList.add("is-clipped");
        resetName(name);
        continue;
      }
      // 用户把图拖 / 放大到这组跑出图外了：不参与摆名字，不然「贴边往里挪」会把名字拖回图里、覆盖框跟着拉到几百像素宽
      if (anchor.x < -60 || anchor.y < -60 || anchor.x > width + 60 || anchor.y > height + 60) {
        resetName(name);
        continue;
      }
      entries.push({ key: `g${cluster.members.map((member) => (member.kind === "host" ? member.id : member.key)).join(",")}`, name, anchor, body, gap: h / 2 + 2, counts });
    }
    // 量名字：先按缩小一号的字号量一遍，再按正常的量（两次回流，marker 就几十个）
    for (const entry of entries) { entry.name.classList.remove("is-off", "is-side"); entry.name.classList.add("is-tight"); }
    const tightWidths = entries.map((entry) => entry.name.offsetWidth || 50);
    for (const entry of entries) { entry.name.classList.remove("is-tight"); entry.name.style.marginLeft = ""; }
    const items: LabelItem[] = entries.map((entry, index) => ({
      key: entry.key, x: entry.body.x + entry.body.w / 2, y: entry.body.y + entry.body.h / 2,
      w: entry.name.offsetWidth || 60, h: entry.name.offsetHeight || 16, tightW: tightWidths[index], gap: entry.gap,
      // 小窗里要框的那几台先挑位置，窗边路过的别的主机后放
      priority: entry.counts ? 0 : 1,
      sideGap: entry.body.w / 2 + 3,
    }));
    // 障碍：圆盘 / 叠起来的 marker、延迟胶囊、角上的小标签（「N 台未定位」、小窗标题）
    const obstacles: PixelBox[] = entries.map((entry) => entry.body);
    const capBoxes = new Map<string, PixelBox>();
    for (const cap of capsAt) {
      const point = viewProject(map, cap.at);
      const button = live.capMarkers.get(cap.key)?.button;
      const w = button?.offsetWidth || 42;
      const h = button?.offsetHeight || 16;
      const box = { x: point.x - w / 2, y: point.y - h / 2, w, h };
      capBoxes.set(cap.key, box);
      obstacles.push(box);
    }
    const frame = container.getBoundingClientRect();
    const reservedBoxes: PixelBox[] = [];
    for (const reserved of Array.from(container.parentElement?.querySelectorAll(":scope > .nm-reserved") ?? [])) {
      const rect = reserved.getBoundingClientRect();
      const box = { x: rect.left - frame.left - 4, y: rect.top - frame.top - 4, w: rect.width + 8, h: rect.height + 8 };
      obstacles.push(box);
      reservedBoxes.push(box);
    }
    const placed = hideMode ? placeInsetLabels(items, obstacles, { width, height }) : placeLabelBoxes(items, obstacles, area);
    const placements = new Map(placed.map((placement) => [placement.key, placement]));
    const fitItems: FitItem[] = [];
    const keepOut: PixelBox[] = [];
    let hiddenLabels = 0;
    for (const entry of entries) {
      const placement = placements.get(entry.key);
      if (!placement) continue;
      if (placement.hidden) {
        // 摆不下的名字不画（圆盘照画，点一下提示里有名字）；框的时候只算圆盘
        entry.name.classList.add("is-off");
        keepOut.push(entry.body);
        if (entry.counts) { fitItems.push({ anchor: entry.anchor, box: entry.body }); hiddenLabels += 1; }
        continue;
      }
      entry.name.classList.toggle("is-up", placement.up);
      // 摆到圆盘旁边：CSS 把名字竖直居中在锚点上，marginLeft 是名字左边缘离锚点多远
      entry.name.classList.toggle("is-side", !!placement.side);
      entry.name.classList.toggle("is-tight", placement.tight);
      entry.name.style.marginLeft = placement.dx ? `${placement.dx}px` : "";
      const box = unionBox([entry.body, placement.box])!;
      keepOut.push(entry.body, placement.box);
      // 小窗框的第一步只按圆盘框：名字摆不下可以藏，圆盘必须都在窗里、还要尽量分开
      if (entry.counts) fitItems.push({ anchor: entry.anchor, box: live.discFit ? entry.body : box });
    }
    // 胶囊不进 keepOut：小窗摆好之后是胶囊沿着弧线躲小窗（capPointIndex），不是小窗躲胶囊 —— 反过来会互相追着跑
    for (const cap of capsAt) {
      const box = capBoxes.get(cap.key);
      if (!box) continue;
      const hosts = cap.line.routeKey ? live.props.model.routes.find((route) => route.key === cap.line.routeKey)?.hosts : live.props.model.links.find((item) => item.id === cap.line.tunnelId)?.path;
      if (!framed || hosts?.every((id) => framed.has(id))) fitItems.push({ anchor: viewProject(map, cap.at), box });
    }
    // 弧线也得在图里：只会让框得更松，不会为了弧线裁掉 marker
    for (const point of live.arcPx) fitItems.push({ anchor: point, box: { x: point.x - 2, y: point.y - 2, w: 4, h: 4 } });
    live.fitItems = fitItems;
    live.keepOut = keepOut;
    live.hiddenLabels = hiddenLabels;
    live.framedBodies = entries.filter((entry) => entry.counts).map((entry) => entry.body);
    // 角上的小标签和 + / − 按钮另报一份：小窗绝不压上去（placeInsets 会把角上的盒子往里挪）
    live.reserved = reservedBoxes;
    // 分组报给卡片：组员的真实位置 + 叠起来的 marker（含名字）占的盒子
    const nodeById = new Map(live.props.model.nodes.map((node) => [node.id, node]));
    live.miniGroups = live.clusterMarkers.map((cluster) => {
      const hostIds = cluster.members.flatMap((member) => (member.kind === "host" ? [member.id] : []));
      const entry = entries.find((item) => item.key === `g${cluster.members.map((member) => (member.kind === "host" ? member.id : member.key)).join(",")}`);
      const placement = entry ? placements.get(entry.key) : undefined;
      // 跑出图外没参与摆名字的组：盒子按 pill 本身算（不能给个 0,0 的空盒，覆盖框会被拉到左上角去）
      const pill = cluster.marker.getElement().querySelector(".nm-mk-pill") as HTMLElement | null;
      const anchor = viewProject(map, cluster.center);
      const pillBox: PixelBox = { x: anchor.x - (pill?.offsetWidth || 50) / 2, y: anchor.y - (pill?.offsetHeight || 18) / 2, w: pill?.offsetWidth || 50, h: pill?.offsetHeight || 18 };
      const markerBox = entry ? unionBox(placement ? [entry.body, placement.box] : [entry.body])! : pillBox;
      // 和 hostIds 一一对应（卡片按下标找组员的位置挑小窗框哪几台）；组员一定有坐标，兜底用组心
      const members = hostIds.map((id) => { const node = nodeById.get(id); return node?.geo ? viewProject(map, display([node.geo.lng, node.geo.lat])) : anchor; });
      return { hostIds, label: cluster.label, members, markerBox };
    });
  };

  /**
   * 精确框住：fitBounds 只知道经纬度，不知道圆盘和名字有多宽，贴边的主机会被裁掉半个盘。
   * 这里量一遍每个 marker 真正占的像素，算出该缩放多少、中心挪到哪（fitViewToBoxes），跳过去，
   * 再量一遍 —— 缩放变了分组会变（两台并成一组、名字翻到另一侧），几轮就收敛。头两轮允许
   * 往里放大（空着的地方别浪费，最多到 9 级），之后只缩不放，量到什么都没出界、也不用再挪
   * 才停：名字宁可露出边也不压别人（placeLabelBoxes），露出的那点由下一轮缩回来。
   */
  const settleFit = () => {
    const map = live.map;
    if (!map || !live.loaded || !compact()) return;
    const container = map.getContainer();
    const size = { width: container.clientWidth, height: container.clientHeight };
    if (size.width < 40 || size.height < 40) return;
    const inset = isInset() ? FIT_INSET.inset : FIT_INSET.mini;
    // 小窗：圈和名字这些像素尺寸不随缩放变，实在放不下时再缩也没用，别缩成一张世界图
    const floorZoom = isInset() ? Math.max(0, map.getZoom() - INSET_MAX_ZOOM_OUT) : 0;
    // 上一次框好之后把 minZoom 抬到了「再缩一级」，这次框可能要更小：先放开
    if (isMini()) map.setMinZoom(0);
    const c0 = { x: size.width / 2, y: size.height / 2 };
    /** 量一次、跳一次；已经收敛（不用再缩放、也不用再挪）就返回 false */
    const step = (maxZoom: number, minZoom: number): boolean => {
      const zoom = map.getZoom();
      const fit = fitViewToBoxes(size, live.fitItems, inset, { maxScale: 2 ** (maxZoom - zoom), minScale: 2 ** (Math.min(minZoom, maxZoom) - zoom) });
      if (!fit) return false;
      if (Math.abs(fit.zoomDelta) < 0.004 && Math.hypot(fit.centerPx.x - c0.x, fit.centerPx.y - c0.y) < 0.75) return false;
      map.jumpTo({ center: map.unproject([fit.centerPx.x, fit.centerPx.y]), zoom: zoom + fit.zoomDelta });
      return true;
    };
    live.settling = true;
    // 小窗先只按圆盘 / pill 框（名字摆不下可以藏，圆盘不行）：按名字框的话，四个 70px 的名字塞不进
    // 一百多像素的窗，只会一路缩到几台又并成一枚 pill —— 那这扇窗就白开了
    live.discFit = isInset();
    try {
      for (let round = 0; round < 6; round += 1) {
        relayout();
        if (!step(round < 2 ? MINI_FIT_MAX_ZOOM : map.getZoom(), floorZoom)) break;
      }
      relayout();
      if (isInset()) {
        // 第二步：按圆盘框到的这一级往外试几档（0 ~ 1.5 级），每档先连名字一起居中、放不下再只按圆盘居中，
        // 按「摆不干净就藏」摆一遍名字，挑名字摆得最好的那档（pickInsetZoom）：窗小的时候，四台分开但
        // 一个名字都没有，不如三枚 marker 名字都在
        const top = map.getZoom();
        const origin = map.getCenter();
        const inside = () => live.framedBodies.every((box) => box.x >= 0 && box.y >= 0 && box.x + box.w <= size.width && box.y + box.h <= size.height);
        const candidates: InsetZoomCandidate[] = [];
        const views: Array<{ center: maplibregl.LngLat; zoom: number }> = [];
        for (const out of INSET_ZOOM_OUT_STEPS) {
          const zoom = top - out;
          if (out > 0 && zoom < floorZoom - 1e-6) break;
          for (const withLabels of [true, false]) {
            map.jumpTo({ center: origin, zoom });
            live.discFit = !withLabels;
            for (let round = 0; round < 3; round += 1) { relayout(); if (!step(zoom, zoom)) break; }
            live.discFit = false;
            live.labelProbe = true;
            relayout();
            live.labelProbe = false;
            const valid = inside();
            if (!valid && withLabels) continue;
            candidates.push({ zoom, markers: live.framedBodies.length, hidden: live.hiddenLabels, valid });
            views.push({ center: map.getCenter(), zoom });
            break;
          }
        }
        const best = pickInsetZoom(candidates);
        if (best >= 0) map.jumpTo(views[best]);
      }
    } finally {
      live.settling = false;
      live.discFit = false;
      live.labelProbe = false;
    }
    if (isInset()) {
      // 框好了：再摆一遍名字，这回摆不干净的藏起来；报给卡片藏了几个（手机上它据此试着把窗放大一号）
      relayout();
      live.props.onInsetLayout?.({ width: size.width, height: size.height, hiddenLabels: live.hiddenLabels });
    }
    // 用户最多能缩到框好的再小一级
    if (isMini()) map.setMinZoom(miniMinZoom(map.getZoom()));
    reportSettled();
  };

  /** 框好 / 卡片变宽但用户动过图不重框 / 主机集合变了：报一次「可以重新摆小窗了」 */
  const reportSettled = () => {
    live.settledReport = true;
    try { reportMiniLayout(); } finally { live.settledReport = false; }
  };

  /** 用户自己拖了 / 缩了：以后不再自动框，卡片显示「回到全览」 */
  const markUserMoved = () => {
    if (!isMini() || live.userMoved) return;
    live.userMoved = true;
    reportMiniLayout();
  };

  /** 主图把分组和占用情况交给卡片（摆小窗用）；没变就不吵它 */
  const reportMiniLayout = () => {
    const map = live.map;
    if (!map || !isMini() || live.settling || !live.props.onMiniLayout) return;
    const container = map.getContainer();
    const round = (value: number) => Math.round(value * 10) / 10;
    const roundBox = (box: PixelBox): PixelBox => ({ x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h) });
    const report: MiniLayoutReport = {
      width: container.clientWidth,
      height: container.clientHeight,
      groups: live.miniGroups.map((group) => ({ ...group, members: group.members.map((point) => ({ x: round(point.x), y: round(point.y) })), markerBox: roundBox(group.markerBox) })),
      boxes: live.keepOut.map(roundBox),
      points: live.arcPx.map((point) => ({ x: round(point.x), y: round(point.y) })),
      reserved: live.reserved.map(roundBox),
      settled: live.settledReport,
      userMoved: live.userMoved,
    };
    const signature = JSON.stringify(report);
    if (signature === live.lastReport) return;
    live.lastReport = signature;
    live.props.onMiniLayout(report);
  };

  /**
   * 胶囊挂在弧线的哪个点上：默认正中；小图上卡片把小窗摆好之后（avoidBoxes），中点被小窗
   * 盖住的就沿着弧线往两头挪，挪到第一个既不在小窗下、也没出卡片边的点。
   */
  const capPointIndex = (points: LngLat[], key: string, extra: readonly PixelBox[] = []): number => {
    const map = live.map;
    const middle = Math.floor(points.length / 2);
    // 小图上躲小窗；两种图上都躲主机的点 / 组、已经挂好的别的延迟牌子（两条几乎平行的线，牌子别叠成一个）
    const avoid = [...(compact() ? live.props.avoidBoxes ?? [] : []), ...extra];
    if (!map || avoid.length === 0) return middle;
    const container = map.getContainer();
    const width = container.clientWidth;
    const height = container.clientHeight;
    const button = live.capMarkers.get(key)?.button;
    const w = button?.offsetWidth || 42;
    const h = button?.offsetHeight || 16;
    const clear = (index: number) => {
      const point = viewProject(map, points[index]);
      const box: PixelBox = { x: point.x - w / 2, y: point.y - h / 2, w, h };
      if (box.x < MINI_FIT_INSET_PX || box.y < MINI_FIT_INSET_PX || box.x + box.w > width - MINI_FIT_INSET_PX || box.y + box.h > height - MINI_FIT_INSET_PX) return false;
      return !avoid.some((other) => other.x < box.x + box.w && box.x < other.x + other.w && other.y < box.y + box.h && box.y < other.y + other.h);
    };
    if (clear(middle)) return middle;
    for (let step = 1; step * 3 < points.length / 2; step += 1) {
      for (const index of [middle - step * 3, middle + step * 3]) if (index > 0 && index < points.length - 1 && clear(index)) return index;
    }
    return middle;
  };

  // ---- 布局：簇 / 错开，再把线、⊗ 和牌子挂上去 ----
  const relayout = () => {
    const map = live.map;
    if (!map || !live.loaded || !map.getSource(NETWORK_MAP_SOURCES.links)) return;
    const { model, showFlows, focus } = live.props;
    const hub = live.props.hubHostId ?? null;
    const mini = compact();
    const zoom = map.getZoom();
    // 主图和小窗：圆盘会压在一起的并成一组（每台都在真实坐标上，不错开）。小窗里还叠着的（要框的几台里
    // 有一台远，窗放不大）照样并成一枚小 pill 画在真正的组心，不再错开成一圈 —— 圈上的名字互相压、被窗边切掉
    const flagOf = new Map(model.nodes.map((node) => [`h${node.id}`, node.emoji]));
    const layoutOptions: MapLayoutOptions = mini ? miniGroupLayoutOptions(flagOf) : {};
    live.layout = computeMapLayout(layoutPoints(), (lngLat) => map.project(lngLat as [number, number]), zoom, layoutOptions);
    const layout = live.layout;
    for (const [id, entry] of live.hostMarkers) {
      const position = layout.pos[`h${id}`];
      if (!position) continue;
      entry.element.classList.toggle("is-hidden", position.clusterId !== null);
      entry.marker.setLngLat(position.lngLat as [number, number]).setOffset(position.offset);
    }
    for (const [key, entry] of live.targetMarkers) {
      const position = layout.pos[`t:${key}`];
      if (!position) continue;
      entry.element.classList.toggle("is-hidden", position.clusterId !== null);
      entry.marker.setLngLat(position.lngLat as [number, number]).setOffset(position.offset);
    }
    for (const cluster of live.clusterMarkers) cluster.marker.remove();
    live.clusterMarkers = [];
    const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
    const targetByKey = new Map(model.targets.map((target) => [target.key, target]));
    for (const group of layout.groups) {
      const members: Array<{ kind: "host"; id: number } | { kind: "target"; key: string }> = [];
      const cities: string[] = [];
      let tone: NodeTone | "target" = "ok";
      let rank = TONE_RANK.ok;
      const consider = (next: NodeTone) => { if (TONE_RANK[next] < rank) { rank = TONE_RANK[next]; tone = next; } };
      let hasHost = false;
      for (const key of group.keys) {
        if (key.startsWith("h")) {
          const node = nodeById.get(Number(key.slice(1)));
          if (!node) continue;
          hasHost = true;
          members.push({ kind: "host", id: node.id });
          if (!cities.includes(node.city)) cities.push(node.city);
          const nodeToneValue = nodeTone(model, node.id, hub);
          // 枢纽在组里：组画成枢纽的蓝（除非组里有人出了问题）
          if (nodeToneValue === "hub") { if (rank >= TONE_RANK.ok) { tone = "hub"; rank = TONE_RANK.ok; } } else consider(nodeToneValue);
        } else {
          const target = targetByKey.get(key.slice(2)) as NetworkMapTarget | undefined;
          if (!target) continue;
          members.push({ kind: "target", key: target.key });
          if (target.health === "down") consider("down");
        }
      }
      if (!hasHost && rank >= TONE_RANK.ok) tone = "target";
      const label = groupPlaceLabel(cities) || "落地节点";
      // 一组：一枚大一号的发光环，里面写几台；组里最该被看到的那个颜色画在环上
      const element = el(`<div class="nm-mk nm-mk-cluster is-${tone}"><button type="button" class="nm-mk-pill" aria-label="${escapeHtml(label)}，${group.keys.length} 个，${mini ? "点击查看" : "点击放大"}"><b class="nm-mk-count">${group.keys.length}</b></button><div class="nm-mk-name"><b class="nm-mk-city">${escapeHtml(label)}</b></div></div>`);
      const center = group.center;
      const hostIds = members.flatMap((member) => (member.kind === "host" ? [member.id] : []));
      (element.firstElementChild as HTMLElement).addEventListener("click", (event) => {
        event.stopPropagation();
        const target = live.map;
        if (!target) return;
        const nextZoom = Math.max(6.3, target.getZoom() + 2.2);
        // 小图不飞：只回调（卡片提示这组是谁）；整页上簇心已经是显示坐标（高德下转过 GCJ-02 的），直接飞，不走 api.flyTo 再转一次
        if (!compact()) {
          if (live.props.reduceMotion) target.jumpTo({ center: center as [number, number], zoom: nextZoom });
          else target.flyTo({ center: center as [number, number], zoom: nextZoom, speed: 0.9, curve: 1.42, maxDuration: 1800, essential: true });
        }
        live.props.onSelectCluster(center, nextZoom, hostIds);
      });
      const marker = new maplibregl.Marker({ element, anchor: "center" }).setLngLat(center as [number, number]).addTo(map);
      live.clusterMarkers.push({ marker, members, center, label });
    }

    // 线：每一跳一条大圆弧；两端在同一个簇里就不画（簇已经说明它们在一起）
    const linkFeatures: any[] = [];
    const waypointFeatures: any[] = [];
    type Cap = { key: string; at: LngLat; text: string; kind: "break" | "latency"; line: LineRef; label: string };
    const caps: Cap[] = [];
    const capMinArcPx = mini ? MINI_CAP_MIN_ARC_PX : CAP_MIN_ARC_PX;
    // 牌子和 ⊗ 要躲开的：每台主机的环、每一组，和先挂好的牌子
    const capAvoid: PixelBox[] = [];
    for (const [key, position] of Object.entries(layout.pos)) {
      if (position.clusterId !== null || !key.startsWith("h")) continue;
      const at = viewProject(map, position.lngLat);
      const r = mini ? MINI_DISC_R : 13;
      capAvoid.push({ x: at.x + position.offset[0] - r, y: at.y + position.offset[1] - r, w: r * 2, h: r * 2 });
    }
    for (const group of layout.groups) {
      const at = viewProject(map, group.center);
      capAvoid.push({ x: at.x - 15, y: at.y - 15, w: 30, h: 30 });
    }
    const unitsPerPixel = mercatorUnitsPerPixel(zoom);
    const comets: Live["comets"] = [];
    const framed = framedHostIds();
    const arcPx: PixelPoint[] = [];
    live.linkFeatureIds = [];
    live.waypointFeatureIds = [];
    /*
      同一对主机之间不止一条线（主线路和它的备用隧道、一来一回两条隧道、线路组的路径）：同一条大圆弧
      上叠好几条，虚线压在实线上根本看不出来。第二条起往两边各弯开一点（屏幕上 14px 一档），
      弯的方向按主机 id 小的那头定，一来一回的两条不会弯到同一边。
    */
    const pairSlots = new Map<string, number>();
    const bend = (points: LngLat[], from: number, to: number): LngLat[] => {
      const key = from < to ? `${from}-${to}` : `${to}-${from}`;
      const slot = pairSlots.get(key) ?? 0;
      pairSlots.set(key, slot + 1);
      if (slot === 0 || points.length < 3) return points;
      const offset = Math.ceil(slot / 2) * 14 * (slot % 2 === 1 ? 1 : -1) * (from < to ? 1 : -1);
      const px = points.map((point) => map.project(point as [number, number]));
      const first = px[0];
      const last = px[px.length - 1];
      const length = Math.hypot(last.x - first.x, last.y - first.y) || 1;
      const nx = -(last.y - first.y) / length;
      const ny = (last.x - first.x) / length;
      return px.map((point, index) => {
        const o = Math.sin((Math.PI * index) / (px.length - 1)) * offset;
        const at = map.unproject([point.x + nx * o, point.y + ny * o]);
        // unproject 可能把经度绕回 [-180, 180]：跨太平洋的弧要和原来那点在同一份世界里
        const lng = at.lng + Math.round((points[index][0] - at.lng) / 360) * 360;
        return [lng, at.lat] as LngLat;
      });
    };
    /** 一条线（隧道或线路组的一条路径）按经过的主机一跳一跳画 */
    const drawLine = (line: LineRef, hosts: readonly number[], prefix: string, latencyText: string | null, label: string) => {
      const capIndex = Math.floor((hosts.length - 2) / 2);
      // 主线路跑光点：把画出来的各跳首尾相接；中间有一跳没画（两端同簇）就断开成两段
      let hopRun: LngLat[][] = [];
      let hopRunStart = 0;
      const flush = () => {
        const path = hopRun.length > 0 ? buildCometPath(hopRun) : null;
        if (path) {
          const screen = path.total / unitsPerPixel;
          comets.push({ key: `${prefix}:${hopRunStart}`, line, path, periodMs: cometPeriodMs(screen), count: screen >= PARTICLES_LONG_PX ? PARTICLES_LONG : PARTICLES_SHORT });
        }
        hopRun = [];
      };
      for (let index = 0; index < hosts.length - 1; index += 1) {
        const keyA = `h${hosts[index]}`;
        const keyB = `h${hosts[index + 1]}`;
        const posA = layout.pos[keyA];
        const posB = layout.pos[keyB];
        if (!posA || !posB) { flush(); continue; }
        if (posA.clusterId !== null && posA.clusterId === posB.clusterId) { flush(); continue; }
        const a = displayLngLat(keyA);
        const b = displayLngLat(keyB);
        if (!a || !b) { flush(); continue; }
        const points = bend(greatCircleArc(a, b), hosts[index], hosts[index + 1]);
        const fid = `${prefix}:${index}`;
        live.linkFeatureIds.push({ fid, ...line });
        // 虚线按主机 id 小的那头起笔：同一跳上一来一回的两条虚线相位对得上、重成一条，
        // 不然两套错开的虚线叠成一串拉链。主线路的渐变要入口 → 出口，不能翻；光点照用原方向
        const linePoints = line.kind !== "main" && hosts[index] > hosts[index + 1] ? [...points].reverse() : points;
        linkFeatures.push({ type: "Feature", properties: { fid, tunnel: line.tunnelId, route: line.routeKey ?? "", entry: line.entryHostId, kind: line.kind }, geometry: { type: "LineString", coordinates: linePoints } });
        if (line.kind === "main") { if (hopRun.length === 0) hopRunStart = index; hopRun.push(points); }
        // 备用线路经过的中转：一颗灰色小点（主机的环盖住它；并进组时它还在，看得出线是在这儿拐的）
        if (line.kind === "backup" && index < hosts.length - 2) {
          const wid = `${prefix}:w${index}`;
          live.waypointFeatureIds.push({ fid: wid, ...line });
          waypointFeatures.push({ type: "Feature", properties: { fid: wid }, geometry: { type: "Point", coordinates: b } });
        }
        const inFrame = !framed || (framed.has(hosts[index]) && framed.has(hosts[index + 1]));
        // 小图：弧线每隔几个点记一下落在屏幕哪里，精确框住时弧顶也要在图里、卡片摆小窗时躲开它（小窗只管框内那几台之间的跳）
        if (mini && inFrame) for (let k = 0; k < points.length; k += 4) arcPx.push(viewProject(map, points[k]));
        // 两端在屏幕上挨得太近时牌子会盖住环，线短到放不下就不挂；小窗里只给窗内两台之间的那一跳挂
        const pa = viewProject(map, points[0]);
        const pb = viewProject(map, points[points.length - 1]);
        if (index !== capIndex || !inFrame || Math.hypot(pa.x - pb.x, pa.y - pb.y) < capMinArcPx) continue;
        const kind: Cap["kind"] | null = line.kind === "down" ? "break" : latencyText ? "latency" : null;
        if (!kind) continue;
        const key = `${kind === "break" ? "b" : "t"}:${prefix}`;
        const at = points[capPointIndex(points, key, capAvoid)];
        caps.push({ key, at, text: kind === "break" ? "" : latencyText!, kind, line, label });
        const point = viewProject(map, at);
        const button = live.capMarkers.get(key)?.button;
        const w = button?.offsetWidth || (kind === "break" ? 18 : 42);
        const h = button?.offsetHeight || (kind === "break" ? 18 : 16);
        capAvoid.push({ x: point.x - w / 2 - 2, y: point.y - h / 2 - 2, w: w + 4, h: h + 4 });
      }
      flush();
    };
    // 整页上聚焦的那几条线挂延迟牌子（平时延迟写在主机名下面，线上干干净净）
    const latencyFor = (tunnelId: number, latency?: number | null) => (!mini && focus && focus.tunnels.includes(tunnelId) && typeof latency === "number" ? `${Math.round(latency)} ms` : null);
    for (const link of model.links) drawLine({ tunnelId: link.id, routeKey: null, kind: link.kind, entryHostId: link.path[0] }, link.path, `t:${link.id}`, latencyFor(link.id, link.latencyMs), link.name);
    for (const route of model.routes) drawLine({ tunnelId: route.tunnelId ?? 0, routeKey: route.key, kind: route.kind, entryHostId: route.hosts[0] }, route.hosts, route.key, null, `${route.ruleName} · ${route.name}`);
    live.comets = comets;
    live.arcPx = arcPx;
    for (const key of Array.from(live.cometPhase.keys())) if (!comets.some((comet) => comet.key === key)) live.cometPhase.delete(key);
    (map.getSource(NETWORK_MAP_SOURCES.waypoints) as GeoJSONSource).setData({ type: "FeatureCollection", features: waypointFeatures });
    // 看不到一端的隧道：从看得见的那一端伸出一小截灰线（小图上省掉，卡片底下有一句「N 条没画出来」）
    const seenStubs = new Set<number>();
    for (const stub of mini ? [] : model.stubs) {
      const key = `h${stub.hostId}`;
      const position = layout.pos[key];
      if (!position || position.clusterId !== null) continue;
      const from = displayLngLat(key);
      if (!from) continue;
      const point = map.project(from as [number, number]);
      const end = map.unproject([point.x + 58, point.y - 44]);
      const to: LngLat = [end.lng, end.lat];
      const fid = `s:${stub.tunnelId}`;
      live.linkFeatureIds.push({ fid, tunnelId: stub.tunnelId, routeKey: null, kind: "backup", entryHostId: stub.hostId });
      linkFeatures.push({ type: "Feature", properties: { fid, tunnel: stub.tunnelId, route: "", entry: stub.hostId, kind: "backup" }, geometry: { type: "LineString", coordinates: [from, to] } });
      seenStubs.add(stub.tunnelId);
      let marker = live.stubMarkers.get(stub.tunnelId);
      if (!marker) {
        const element = el(`<div class="nm-mk"><div class="nm-mk-stub">看不到的主机</div></div>`);
        element.title = `${stub.name} 的另一端不在你的主机范围里`;
        marker = new maplibregl.Marker({ element, anchor: "center" }).setLngLat(to as [number, number]).addTo(map);
        live.stubMarkers.set(stub.tunnelId, marker);
      } else marker.setLngLat(to as [number, number]);
    }
    for (const [tunnelId, marker] of live.stubMarkers) {
      if (seenStubs.has(tunnelId)) continue;
      marker.remove();
      live.stubMarkers.delete(tunnelId);
    }
    (map.getSource(NETWORK_MAP_SOURCES.links) as GeoJSONSource).setData({ type: "FeatureCollection", features: linkFeatures });

    // 落地流向：出口 → 落地节点的紫色细虚线
    const flowFeatures: any[] = [];
    live.flowFeatureIds = [];
    if (showFlows) {
      for (const target of model.targets) {
        if (!target.geo) continue;
        const targetKey = `t:${target.key}`;
        const posT = layout.pos[targetKey];
        if (!posT) continue;
        for (const hostId of target.sourceHostIds) {
          const hostKey = `h${hostId}`;
          const posH = layout.pos[hostKey];
          if (!posH) continue;
          if (posH.clusterId !== null && posH.clusterId === posT.clusterId) continue;
          const a = displayLngLat(hostKey);
          const b = displayLngLat(targetKey);
          if (!a || !b) continue;
          const fid = `f:${hostId}:${target.key}`;
          live.flowFeatureIds.push({ fid, targetKey: target.key, ruleIds: target.ruleIds });
          flowFeatures.push({ type: "Feature", properties: { fid }, geometry: { type: "LineString", coordinates: greatCircleArc(a, b) } });
        }
      }
    }
    (map.getSource(NETWORK_MAP_SOURCES.flows) as GeoJSONSource).setData({ type: "FeatureCollection", features: flowFeatures });

    // 线上的牌子：中断的 ⊗、聚焦时的延迟；按 key 复用
    const seenCaps = new Set<string>();
    for (const cap of caps) {
      seenCaps.add(cap.key);
      let entry = live.capMarkers.get(cap.key);
      if (!entry) {
        // marker 元素本身会被 MapLibre 写 transform 定位，所以按钮套在一个 0×0 的壳里，
        // 自己再用 translate(-50%, -50%) 居中；直接把按钮当 marker 元素，它的居中会被盖掉
        const element = el(`<div class="nm-mk"><button type="button" class="nm-mk-cap"></button></div>`);
        const button = element.firstElementChild as HTMLButtonElement;
        button.addEventListener("click", (event) => { event.stopPropagation(); const current = live.capMarkers.get(cap.key); if (current) selectLine(current.line); });
        const marker = new maplibregl.Marker({ element, anchor: "center" }).setLngLat(cap.at as [number, number]).addTo(map);
        entry = { marker, element, button, line: cap.line };
        live.capMarkers.set(cap.key, entry);
      } else entry.marker.setLngLat(cap.at as [number, number]);
      entry.line = cap.line;
      entry.button.className = `nm-mk-cap ${cap.kind === "break" ? "is-break" : `is-${cap.line.kind}`}`;
      if (cap.kind === "break") { if (!entry.button.querySelector("svg")) entry.button.innerHTML = BREAK_ICON; }
      else entry.button.textContent = cap.text;
      entry.button.setAttribute("aria-label", cap.kind === "break" ? `${cap.label} 中断，查看链路` : `${cap.label} ${cap.text}，查看链路`);
    }
    for (const [key, entry] of live.capMarkers) {
      if (seenCaps.has(key)) continue;
      entry.marker.remove();
      live.capMarkers.delete(key);
    }
    if (mini) {
      placeCompactLabels(caps.map((cap) => ({ key: cap.key, at: cap.at, line: cap.line })));
      reportMiniLayout();
    }
    // 名字和国名最后摆：环、组、牌子都就位了才知道它们会不会压到谁
    updatePageLabels();
    updateCountryLabels();
    applyFocus();
  };

  /** 点了一条线：隧道开隧道；线路组的路径没有自己的详情，开它出发的那台主机（抽屉里有这条规则） */
  const selectLine = (line: LineRef) => {
    if (line.tunnelId > 0) live.props.onSelectLink(line.tunnelId);
    else if (line.entryHostId > 0) live.props.onSelectNode(line.entryHostId);
  };

  const scheduleRelayout = () => {
    if (live.relayoutFrame) return;
    live.relayoutFrame = requestAnimationFrame(() => { live.relayoutFrame = 0; relayout(); });
  };

  // ---- 聚焦和筛选：线用 feature-state（dim 压暗、hide 不画），marker 用 class ----
  const lineDimmed = (line: LineRef) => (line.routeKey ? isRouteDimmed(live.props.focus, line.routeKey) : isTunnelDimmed(live.props.focus, line.tunnelId));
  const lineHidden = (line: LineRef) => !lineVisible(line.kind, live.props.lineFilter ?? "all");
  const applyFocus = () => {
    const map = live.map;
    if (!map || !live.loaded || !map.getSource(NETWORK_MAP_SOURCES.links)) return;
    const { focus, model } = live.props;
    const filterHosts = hostsForFilter(model, live.props.lineFilter ?? "all");
    const hostOff = (id: number) => isHostDimmed(focus, id) || (!!filterHosts && !filterHosts.has(id));
    for (const feature of live.linkFeatureIds) map.setFeatureState({ source: NETWORK_MAP_SOURCES.links, id: feature.fid }, { dim: lineDimmed(feature), hide: lineHidden(feature) });
    for (const feature of live.waypointFeatureIds) map.setFeatureState({ source: NETWORK_MAP_SOURCES.waypoints, id: feature.fid }, { dim: lineDimmed(feature), hide: lineHidden(feature) });
    for (const feature of live.flowFeatureIds) map.setFeatureState({ source: NETWORK_MAP_SOURCES.flows, id: feature.fid }, { dim: isFlowDimmed(focus, feature.targetKey, feature.ruleIds) || !!filterHosts });
    for (const [id, entry] of live.hostMarkers) entry.element.classList.toggle("is-dim", hostOff(id));
    for (const [key, entry] of live.targetMarkers) entry.element.classList.toggle("is-dim", isTargetDimmed(focus, key) || !!filterHosts);
    for (const entry of live.capMarkers.values()) {
      entry.element.classList.toggle("is-dim", lineDimmed(entry.line));
      entry.element.classList.toggle("is-filtered", lineHidden(entry.line));
    }
    for (const [tunnelId, marker] of live.stubMarkers) {
      marker.getElement().classList.toggle("is-dim", isTunnelDimmed(focus, tunnelId));
      marker.getElement().classList.toggle("is-filtered", !lineVisible("backup", live.props.lineFilter ?? "all"));
    }
    for (const cluster of live.clusterMarkers) {
      const off = isClusterDimmed(focus, cluster.members) || (!!filterHosts && !cluster.members.some((member) => member.kind === "host" && filterHosts.has(member.id)));
      cluster.marker.getElement().classList.toggle("is-dim", off);
    }
  };

  // ---- 相机 ----
  const api: NetworkMapCameraApi = {
    flyTo(lngLat, zoom) {
      const map = live.map;
      if (!map) return;
      const center = display(lngLat) as [number, number];
      // 抽屉的高度已经通过 setPadding 告诉了地图，这里不再传 padding，传了会算两遍
      if (live.props.reduceMotion) map.jumpTo({ center, zoom });
      else map.flyTo({ center, zoom, speed: 0.9, curve: 1.42, maxDuration: 1800, essential: true });
    },
    fitPoints(points, maxZoom = 8) {
      const map = live.map;
      if (!map || points.length === 0) return;
      const bounds = boundsForPoints(points.map((point) => display(point)));
      if (!bounds) return;
      map.fitBounds(bounds, { maxZoom, padding: FIT_PADDING, duration: live.props.reduceMotion ? 0 : 1200, essential: true });
    },
    fitAll() {
      const map = live.map;
      if (!map) return;
      // 小图：不管是首次、卡片变宽、主机集合变了还是「回到全览」，框住全部就是回到了自动的视角
      live.userMoved = false;
      const framed = framedHostIds();
      // 小窗只框它那几台；主图和整页框全部
      const points = layoutPoints().filter((point) => !framed || (point.key.startsWith("h") && framed.has(Number(point.key.slice(1))))).map((point) => point.lngLat);
      if (points.length === 0) { map.jumpTo({ center: [110, 25], zoom: 1.6 }); return; }
      if (isMini()) {
        // 大圆弧往高纬度弯出去的那一段也得框进来，不然日美那条线的弧顶一打开就在卡片外面
        const nodeById = new Map(live.props.model.nodes.map((node) => [node.id, node]));
        for (const link of live.props.model.links) {
          for (let index = 0; index < link.path.length - 1; index += 1) {
            const a = nodeById.get(link.path[index])?.geo;
            const b = nodeById.get(link.path[index + 1])?.geo;
            if (a && b) points.push(...greatCircleArc(display([a.lng, a.lat]), display([b.lng, b.lat]), 12));
          }
        }
      }
      const bounds = boundsForPoints(points);
      if (!bounds) return;
      // 小图：直接跳过去不飞（卡片刚出现 / 主机集合变了 / 卡片变宽了，飞一下反而像出了错），最多放到 9 级；
      // fitBounds 只是粗放，随后 settleFit 按 marker 真正占的像素精确框一遍
      if (compact()) {
        map.fitBounds(bounds, { maxZoom: MINI_FIT_MAX_ZOOM, padding: isInset() ? INSET_FIT_PADDING : MINI_FIT_PADDING, duration: 0 });
        settleFit();
      } else map.fitBounds(bounds, { maxZoom: 5, padding: FIT_PADDING, duration: live.props.reduceMotion ? 0 : 1200, essential: true });
    },
    zoomBy(delta) {
      const map = live.map;
      if (!map) return;
      markUserMoved();
      const zoom = Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), map.getZoom() + delta));
      map.easeTo({ zoom, duration: live.props.reduceMotion ? 0 : 240, essential: true });
    },
    hostLngLat(hostId) {
      const node = live.props.model.nodes.find((item) => item.id === hostId);
      return node?.geo ? [node.geo.lng, node.geo.lat] : null;
    },
    targetLngLat(key) {
      const target = live.props.model.targets.find((item) => item.key === key);
      return target?.geo ? [target.geo.lng, target.geo.lat] : null;
    },
    getZoom() { return live.map?.getZoom() ?? 0; },
  };

  /** 小图 / 小窗要不要重新框（规则在 shouldRefit）：不框的话也要报一次，卡片好按新尺寸 / 新主机重新摆小窗 */
  const refit = (trigger: MiniFitTrigger) => {
    if (shouldRefit(trigger, live.userMoved)) api.fitAll();
    else { relayout(); reportSettled(); }
  };

  // ---- 动画：主线路上的光点每帧按相位采样一次写进 GeoJSON 源（≤ 几十条线，一帧百来个点，便宜）。
  //      每条路两三颗，均匀错开、首尾相接一直流，不停顿 —— 说的是「这条线上有流量在往出口走」。
  //      压暗的、筛掉的线不跑；页面不可见 / 卡片滚出视野 / 减少动态时全停 ----
  const clearComets = () => {
    const map = live.map;
    if (!map || !live.loaded || !live.cometDrawn) return;
    const source = map.getSource(NETWORK_MAP_SOURCES.particles) as GeoJSONSource | undefined;
    source?.setData({ type: "FeatureCollection", features: [] });
    live.cometDrawn = false;
  };
  const tickAnimation = (timestamp: number) => {
    const map = live.map;
    const running = live.loaded && !live.props.paused && !live.props.reduceMotion && document.visibilityState === "visible";
    const cometsOn = map && running && live.props.comets !== false && live.comets.length > 0;
    if (map && cometsOn) {
      const source = map.getSource(NETWORK_MAP_SOURCES.particles) as GeoJSONSource | undefined;
      if (source) {
        const dt = live.cometLast ? Math.min(COMET_MAX_FRAME_MS, timestamp - live.cometLast) : 0;
        const features: any[] = [];
        for (const comet of live.comets) {
          if (lineDimmed(comet.line) || lineHidden(comet.line)) continue;
          // 每条线错开出发时刻（按 id 和 key 取相位），不然所有光点齐刷刷一起走
          const phase = advanceCometPhase(live.cometPhase.get(comet.key) ?? ((comet.line.tunnelId * 0.37 + comet.key.length * 0.113) % 1), dt, comet.periodMs);
          live.cometPhase.set(comet.key, phase);
          for (let k = 0; k < comet.count; k += 1) {
            const progress = (phase + k / comet.count) % 1;
            features.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: pointAt(comet.path, progress * comet.path.total) } });
          }
        }
        source.setData({ type: "FeatureCollection", features });
        live.cometDrawn = true;
      }
      live.cometLast = timestamp;
    } else {
      live.cometLast = 0;
      clearComets();
    }
    live.animFrame = requestAnimationFrame(tickAnimation);
  };

  // ---- 底图：改可见性和压色；高德瓦片拉不下来时页面会切回标准地图，这里把瓦片层关掉，不再白请求 ----
  const applyBaseLayer = (baseLayer: NetworkMapBaseLayerId) => {
    const map = live.map;
    if (!map || !live.loaded) return;
    const patch = baseLayerPaintPatch(baseLayer);
    map.setPaintProperty(NETWORK_MAP_LAYERS.land, "fill-opacity", patch.landOpacity);
    map.setPaintProperty(NETWORK_MAP_LAYERS.borders, "line-width", patch.borderWidth);
    map.setPaintProperty(NETWORK_MAP_LAYERS.borders, "line-opacity", patch.borderOpacity);
    map.setLayoutProperty(NETWORK_MAP_LAYERS.graticule, "visibility", patch.graticule);
    for (const [id, visibility] of Object.entries(patch.raster)) {
      if (!map.getLayer(id)) continue;
      map.setLayoutProperty(id, "visibility", visibility);
      for (const [property, value] of Object.entries(patch.rasterPaint[id] ?? {})) map.setPaintProperty(id, property, value);
    }
  };

  /** 面板切了主题：地图本身永远深色，但强调色这些令牌可能跟着变 —— 从 CSS 变量里再读一遍 */
  const applySkinColors = () => {
    const map = live.map;
    if (!map || !live.loaded) return;
    const holder = containerRef.current?.parentElement ?? null;
    live.colors = readColors(holder);
    const base = readBaseColors(holder);
    map.setPaintProperty(NETWORK_MAP_LAYERS.background, "background-color", base.water);
    map.setPaintProperty(NETWORK_MAP_LAYERS.land, "fill-color", base.land);
    map.setPaintProperty(NETWORK_MAP_LAYERS.borders, "line-color", base.border);
    map.setPaintProperty(NETWORK_MAP_LAYERS.graticule, "line-color", base.graticule);
    const expression = kindColorExpression(live.colors);
    for (const layer of [NETWORK_MAP_LAYERS.linkGlow, NETWORK_MAP_LAYERS.linkDashed]) map.setPaintProperty(layer, "line-color", expression);
    map.setPaintProperty(NETWORK_MAP_LAYERS.linkMain, "line-gradient", linkGradient(live.colors));
    map.setPaintProperty(NETWORK_MAP_LAYERS.flow, "line-color", live.colors.flow);
    map.setPaintProperty(NETWORK_MAP_LAYERS.waypoints, "circle-color", live.colors.backup);
    map.setPaintProperty(NETWORK_MAP_LAYERS.waypoints, "circle-stroke-color", base.water);
    map.setPaintProperty(NETWORK_MAP_LAYERS.particleGlow, "circle-color", live.colors.main);
    map.setPaintProperty(NETWORK_MAP_LAYERS.particleCore, "circle-color", live.colors.particle);
  };

  // ---- 创建地图（只一次）----
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    live.colors = readColors(container.parentElement);
    const baseColors = readBaseColors(container.parentElement);
    const rasterIds = new Set(rasterSourceIds());
    const mini = compact();
    // 离线地球图的瓦片协议（全局注册一次）
    registerEarthTiles();
    const pannable = isMini();
    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container,
        style: buildNetworkMapStyle(live.props.baseLayer, COUNTRIES_URL, live.colors, baseColors) as any,
        center: [110, 25],
        zoom: 1.6,
        // 小图在 340px 宽的手机卡片里要框住横跨太平洋的线，0.5 级放不下（世界 724px 宽），放开到 0 级
        minZoom: mini ? 0 : 0.5,
        maxZoom: 14,
        attributionControl: false,
        renderWorldCopies: true,
        pitchWithRotate: false,
        dragRotate: false,
        touchPitch: false,
        fadeDuration: 0,
        // 主图能拖、捏合缩放、双击放大；滚轮不缩（滚到卡片上页面还得能往下滚，缩放用角上的 + / −）、
        // 键盘不管（卡片不是焦点）。小窗不能动。点击两种都有（MapEventHandler 不看这个开关）
        interactive: pannable,
        scrollZoom: false,
        keyboard: false,
        dragPan: pannable,
        doubleClickZoom: pannable,
        touchZoomRotate: pannable,
      });
    } catch (error) {
      // 没有 WebGL（远程桌面、老浏览器）：告诉页面画兜底文案
      console.error("[NetworkMap] 地图引擎起不来", error);
      live.props.onUnavailable();
      return undefined;
    }
    live.map = map;
    map.touchZoomRotate.disableRotation();
    map.setPadding(live.props.padding);
    // 初始化挂在 style.load 而不是 load 上：load 要等所有源（包括高德瓦片）都「到达终态」
    // 之后的下一帧才发，而瓦片报错不会再触发重绘 —— 内网 / 被墙时最后一块瓦片失败在
    // 上一帧之后，load 就永远不来，图上一个点都没有。style.load 只看样式本身，源都已建好，
    // setData / setFeatureState / 改图层属性这时都能用；marker 本来就不依赖样式。
    map.once("style.load", () => {
      live.loaded = true;
      applyBaseLayer(live.props.baseLayer);
      syncStaticMarkers();
      relayout();
      if (!live.didInitialFit && layoutPoints().length > 0) { live.didInitialFit = true; live.fitSignature = fitSignature(); api.fitAll(); }
      map.on("zoom", scheduleRelayout);
      // 动画最后一帧的 zoom 事件可能撞上数据源还在重算，zoomend 再算一次兜底
      map.on("zoomend", relayout);
      if (pannable) {
        // 拖图时圈、引线、胶囊的躲让都得跟着（每帧一次 rAF 合并的重排）
        map.on("move", scheduleRelayout);
        map.on("moveend", relayout);
        // 只有用户手上的动作算「动过」：jumpTo / fitBounds / easeTo 发的事件没有 originalEvent
        map.on("dragstart", (event) => { if (event.originalEvent) markUserMoved(); });
        map.on("zoomstart", (event) => { if (event.originalEvent) markUserMoved(); });
      } else if (!mini) {
        // 整页拖图不重新布局，但名字、国名压没压到谁要重新看一眼（拖完看一次就够）
        map.on("moveend", () => { updatePageLabels(); updateCountryLabels(); });
      }
      map.on("click", (event) => {
        // 点在线上（看不见的命中层有 14px 宽，好点）就当点了这条线；筛掉的线不算；点空处交给页面
        const { x, y } = event.point;
        const hits = map.getLayer(NETWORK_MAP_LAYERS.linkHit) ? map.queryRenderedFeatures([[x - 4, y - 4], [x + 4, y + 4]], { layers: [NETWORK_MAP_LAYERS.linkHit] }) : [];
        const hit = hits.find((feature) => !map.getFeatureState({ source: NETWORK_MAP_SOURCES.links, id: String(feature.properties?.fid) })?.hide);
        const properties = hit?.properties;
        if (properties) selectLine({ tunnelId: Number(properties.tunnel) || 0, routeKey: properties.route ? String(properties.route) : null, kind: properties.kind as LineKind, entryHostId: Number(properties.entry) || 0 });
        else live.props.onMapClick();
      });
      live.animFrame = requestAnimationFrame(tickAnimation);
      live.props.onReady(api);
    });
    map.on("error", (event: any) => {
      // 高德瓦片拉不下来：只报一次，页面会切回标准地图并提示
      const sourceId = event?.sourceId || event?.source?.id;
      const isRasterTile = (sourceId && rasterIds.has(String(sourceId))) || (event?.tile && !sourceId);
      if (!isRasterTile) {
        // 注册了 error 监听后 MapLibre 就不再往控制台打了；别的错误（样式、我们自己的
        // 事件处理函数抛的）还是要看得见，否则图上少了东西没人知道为什么
        console.error("[NetworkMap]", event?.error || event);
        return;
      }
      if (live.rasterErrorReported) return;
      if (!NETWORK_MAP_BASE_LAYERS[live.props.baseLayer].amap) return;
      live.rasterErrorReported = true;
      live.props.onRasterError();
    });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
      map.resize();
      // 小图：卡片变宽变窄（转屏、侧栏收起）就重新框一遍，不然一半主机跑到边外；用户动过图就不抢视角，只让卡片重新摆小窗
      if (mini && live.loaded && live.didInitialFit) refit("resize");
      scheduleRelayout();
    }) : null;
    observer?.observe(container);
    return () => {
      observer?.disconnect();
      if (live.relayoutFrame) cancelAnimationFrame(live.relayoutFrame);
      if (live.animFrame) cancelAnimationFrame(live.animFrame);
      live.loaded = false;
      live.map = null;
      live.comets = [];
      live.cometDrawn = false;
      live.hostMarkers.clear();
      live.targetMarkers.clear();
      live.capMarkers.clear();
      live.stubMarkers.clear();
      live.clusterMarkers = [];
      live.countryMarkers.clear();
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 模型 / 流向开关变了：同步 marker，重新布线 ----
  useEffect(() => {
    if (!live.loaded) return;
    syncStaticMarkers();
    relayout();
    if (!live.didInitialFit && layoutPoints().length > 0) { live.didInitialFit = true; live.fitSignature = fitSignature(); api.fitAll(); return; }
    // 主机多了一台 / 少了一台就重新框（用户动过图就不抢，新 marker 照画）；小窗要框的那组变了也一样
    if (compact() && live.didInitialFit) {
      const signature = fitSignature();
      if (signature !== live.fitSignature) { live.fitSignature = signature; refit("hosts"); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.model, props.showFlows, (props.fitHostIds ?? []).join(",")]);

  // ---- 底图变了：改颜色和可见性，坐标按新底图重算 ----
  useEffect(() => {
    const map = live.map;
    if (!map || !live.loaded) return;
    // 用户又选回高德：再拉一次瓦片，拉不下来还是要报（切走时源没人用，MapLibre 会把失败的瓦片扔掉，切回来会重新请求）
    live.rasterErrorReported = false;
    applyBaseLayer(props.baseLayer);
    // 皮肤可能跟着底图换了：等这一帧 data-skin 落到 DOM 上，再从新皮肤的变量里读颜色
    requestAnimationFrame(applySkinColors);
    for (const [id, entry] of live.hostMarkers) {
      const node = props.model.nodes.find((item) => item.id === id);
      if (node?.geo) entry.marker.setLngLat(display([node.geo.lng, node.geo.lat]));
    }
    for (const [key, entry] of live.targetMarkers) {
      const target = props.model.targets.find((item) => item.key === key);
      if (target?.geo) entry.marker.setLngLat(display([target.geo.lng, target.geo.lat]));
    }
    relayout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.baseLayer]);

  // ---- 面板切了主题：颜色令牌可能跟着变，读一遍 ----
  useEffect(() => {
    if (!live.map || !live.loaded) return;
    requestAnimationFrame(applySkinColors);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.skin]);

  // 聚焦变了：整页上要给聚焦的线挂 / 摘延迟牌子，重新布一次线；小图上只改压暗
  useEffect(() => {
    if (compact()) applyFocus();
    else relayout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus]);
  useEffect(() => { applyFocus(); updateCountryLabels(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [props.lineFilter]);
  // 枢纽换了（选了另一台主机）：环的颜色跟着换
  useEffect(() => {
    if (!live.loaded) return;
    syncStaticMarkers();
    applyFocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.hubHostId]);

  // 小窗摆好 / 挪了：胶囊重新找位置
  const avoidKey = (props.avoidBoxes ?? []).map((box) => `${box.x},${box.y},${box.w},${box.h}`).join(";");
  useEffect(() => {
    if (live.loaded && compact()) relayout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avoidKey]);

  useEffect(() => {
    live.map?.setPadding(props.padding);
  }, [props.padding]);

  useEffect(() => {
    if (!live.map || !live.loaded) return;
    // 减少动态效果：光点停，主线路的渐变还在，方向照样看得出
    if (props.reduceMotion) clearComets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.reduceMotion]);

  return <div ref={containerRef} className={`nm-map${props.variant === "mini" ? " nm-map-mini" : props.variant === "inset" ? " nm-map-inset" : ""}`} aria-label={props.variant === "inset" ? "局部放大" : "网络地图：主机、隧道与落地目标"} />;
}
