import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";

import { MINI_CAP_MIN_ARC_PX, MINI_FIT_INSET_PX, MINI_FIT_MAX_ZOOM, groupPlaceLabel, miniGroupLayoutOptions, miniMinZoom, placeLabelBoxes, shouldRefit, type LabelItem, type MiniFitTrigger } from "@/features/network/networkMapMini";
import { countryLabelAnchors, countryLabelText } from "@/features/network/countryLabels";
import { nodeLatency, nodeTone, type LineKind, type NodeTone } from "@/features/network/networkMapLines";
import type { NetworkMapModel } from "@/features/network/networkMapModel";
import { advanceCometPhase, buildCometPath, cometPeriodMs, mercatorUnitsPerPixel, pointAt, type CometPath } from "@shared/networkMapComet";
import { arrowTriangleAlong, boundsForPoints, computeMapLayout, fitViewToBoxes, greatCircleArc, unionBox, type FitItem, type LayoutPoint, type LngLat, type MapLayout, type PixelBox, type PixelPoint } from "@shared/networkMapGeometry";

import { registerEarthTiles } from "./earthTiles";
import {
  NETWORK_MAP_LAYERS,
  NETWORK_MAP_SOURCES,
  buildNetworkMapStyle,
  kindColorExpression,
  lighten,
  linkGradient,
  type NetworkMapBaseColors,
  type NetworkMapLineColors,
} from "./networkMapStyle";

/**
 * 首页「网络地图」卡片里的那张图。MapLibre 只在这一个文件里出现，卡片用 lazy() 动态引入它 ——
 * 地图引擎有几百 KB，不该跟着首页的首屏包一起下。
 *
 * 一眼要看明白的东西只有这几样：
 *   底图  夜晚的地球，固定一张（没有切换）。
 *   主机  真实坐标上一圈发光的环，颜色说状态（正常绿、枢纽亮蓝、降级琥珀、中断红、没接入灰）；
 *         除了颜色，环的样子也说健康（降级外面多一圈虚线、中断中间一个叉、没接入是半透明的环），
 *         色弱的人也分得清。环下面写中文城市名，摆得下时再写一行到这台的延迟。
 *   组    屏幕上挨得太近、环会压在一起的几台并成一枚带数量的环，下面写这几台的城市；点一下
 *         就把这一组的主机框进画面（组自然散开、各自显示名字）。
 *   线    霓虹：宽而模糊的光 + 细而亮的芯。蓝色实线是主线路、橙色虚线降级、红色虚线中断（正中一个 ⊗）、
 *         灰白虚线备用；出口那头一个同色的小箭头；主线路上两三颗光点往出口流（页面看不见、卡片滚出
 *         视野、系统要求减少动态时停）。
 *
 * 能拖、能捏合缩放、双击放大（滚轮不缩：滚轮要留给页面滚动，卡片角上有 + / −）。点主机 / 线 / 组只回调，
 * 卡片在底部闪一句提示，哪儿都不跳。默认视角框住所有定位到的主机：fitBounds 先粗放，再按每个 marker
 * 真正占的像素精确框一遍，谁都不会被边裁掉；用户拖过 / 缩过之后（userMoved）就不再自动框，直到卡片
 * 叫 fitAll（「回到全览」）。
 */

export type NetworkMapCameraApi = {
  /** 框住全部，同时清掉 userMoved（首次、卡片变宽、主机集合变了、「回到全览」） */
  fitAll(): void;
  /** 角上的 + / −：放大 / 缩小一级，算用户动过图 */
  zoomBy(delta: number): void;
};

export type NetworkMapCanvasProps = {
  model: NetworkMapModel;
  /** 面板主题：变了要从 CSS 重新读一遍颜色（图本身永远深色，但强调色这些令牌可能跟着变） */
  skin: "light" | "dark";
  reduceMotion: boolean;
  /** 页面不可见 / 卡片滚出视野时停掉流动光点 */
  paused: boolean;
  /** 画成亮蓝、光晕大一圈的那台（pickHubNode） */
  hubHostId: number | null;
  onSelectNode: (hostId: number) => void;
  onSelectLink: (tunnelId: number) => void;
  /** 点了一组：画布已经把这组框进画面，卡片只管提示 */
  onSelectGroup: (hostIds: number[], label: string) => void;
  /** 用户拖过 / 缩过（true），或者回到了全览（false）：卡片据此显示「回到全览」 */
  onUserMovedChange: (moved: boolean) => void;
  /** 建不出 WebGL 上下文（远程桌面、老浏览器、被禁用了硬件加速）：卡片退回示意图 */
  onUnavailable: () => void;
  onReady: (api: NetworkMapCameraApi) => void;
};

const COUNTRIES_URL = "/globe/ne_110m_admin_0_countries.geojson";

/**
 * 国家名的标注点：和底图用的是同一份国界文件（浏览器已经缓存了，MapLibre 也是拉它），
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

/** fitBounds 只是粗放一下，随后按 marker 真正占的像素精确框（settleFit），所以留白不用算得很准 */
const FIT_PADDING = { top: 34, bottom: 44, left: 52, right: 52 };
/** 精确框住时 marker 离容器边至少这么远 */
const FIT_INSET = { top: MINI_FIT_INSET_PX, right: MINI_FIT_INSET_PX, bottom: MINI_FIT_INSET_PX, left: MINI_FIT_INSET_PX };
/** 点一组时框住组员：最多放到这一级、四周留这么多 */
const GROUP_FIT = { maxZoom: 9, padding: 56 };
/**
 * 一台主机占的盒子半径（摆名字、精确框住、并组都按它）：14px 的环加一圈光，外接一个 20px 的方块；
 * 名字离锚点 10px —— 正好贴着这个方块（networkMap.css 的 .nm-mk-name 的 top / bottom 必须是同一个数）。
 */
const DISC_R = 10;
const LABEL_GAP = 10;
/** 组的环 20px：箭头、⊗ 躲开它时按这个半径 */
const GROUP_R = 10;
/** 出口端箭头：长、两腰收窄的比例，箭尖从环的边缘退开多远（单台 / 组） */
const ARROW = { size: 7, widthRatio: 0.45, backoffHost: 11, backoffGroup: 13 };

/** 一帧最多按这么多毫秒推进：切回标签页时不让光点一下跳半圈 */
const COMET_MAX_FRAME_MS = 100;
/** 一条路上同时流着几颗光点：屏幕上短的两颗，长的三颗，均匀错开 */
const PARTICLES_SHORT = 2;
const PARTICLES_LONG = 3;
const PARTICLES_LONG_PX = 220;

const FALLBACK_COLORS: NetworkMapLineColors = { main: "#3b82f6", backup: "#cbd5e1", degraded: "#f59e0b", down: "#ef4444", particle: "#e0f2fe" };
const FALLBACK_BASE: NetworkMapBaseColors = { water: "#000213", land: "#060a1d", border: "rgba(56,189,248,0.22)" };

/** 一组里最该被看到的那个颜色：中断 > 降级 > 没接入 > 正常 */
const TONE_RANK: Record<NodeTone, number> = { down: 0, warn: 1, standby: 2, ok: 3, hub: 4 };

/**
 * 把任何 CSS 颜色（含 var() 解析后的 oklch / rgb 空格写法）归一成 MapLibre 认的 `#rrggbb` 或 `rgba()`：
 * 让浏览器自己解析一遍再读回来。解析不了返回 fallback。
 */
function resolveCssColor(value: string, fallback: string): string {
  const text = String(value || "").trim();
  if (!text) return fallback;
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return text;
    ctx.fillStyle = "#010203";
    ctx.fillStyle = text;
    const parsed = String(ctx.fillStyle);
    return parsed === "#010203" && text.replace(/\s/g, "").toLowerCase() !== "#010203" ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readCssColor(element: Element | null, name: string, fallback: string): string {
  if (!element) return fallback;
  return resolveCssColor(getComputedStyle(element).getPropertyValue(name), fallback);
}

function readColors(container: HTMLElement | null): NetworkMapLineColors {
  return {
    main: readCssColor(container, "--nm-line-main", FALLBACK_COLORS.main),
    backup: readCssColor(container, "--nm-line-backup", FALLBACK_COLORS.backup),
    degraded: readCssColor(container, "--nm-line-degraded", FALLBACK_COLORS.degraded),
    down: readCssColor(container, "--nm-line-down", FALLBACK_COLORS.down),
    particle: readCssColor(container, "--nm-particle", FALLBACK_COLORS.particle),
  };
}

/** 底图的颜色也是 CSS 令牌，MapLibre 不认 var()，读出来再给它 */
function readBaseColors(container: HTMLElement | null): NetworkMapBaseColors {
  return {
    water: readCssColor(container, "--nm-water", FALLBACK_BASE.water),
    land: readCssColor(container, "--nm-land", FALLBACK_BASE.land),
    border: readCssColor(container, "--nm-border-line", FALLBACK_BASE.border),
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

/** 城市名下面那行：到这台机的延迟，掉线写「离线」、没接入写「未接入」，入口机不写 */
function hostSubline(tone: NodeTone, latency: number | null): string {
  if (tone === "down") return "离线";
  if (tone === "standby") return "未接入";
  return latency === null ? "" : `${Math.round(latency)} ms`;
}

/** 中断的线正中那个 ⊗ */
const BREAK_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" /></svg>`;

type HostMarkerEntry = { marker: Marker; element: HTMLElement; signature: string };
/** 中断的线正中那个 ⊗（`b:<隧道>`） */
type CapEntry = { marker: Marker; element: HTMLElement; button: HTMLButtonElement; tunnelId: number };

type Live = {
  props: NetworkMapCanvasProps;
  map: MapLibreMap | null;
  loaded: boolean;
  colors: NetworkMapLineColors;
  hostMarkers: Map<number, HostMarkerEntry>;
  clusterMarkers: Array<{ marker: Marker; hostIds: number[]; center: LngLat; label: string }>;
  capMarkers: Map<string, CapEntry>;
  /** 有主机的国家写一个国名（按国家代码复用） */
  countryMarkers: Map<string, Marker>;
  layout: MapLayout | null;
  /** 主线路上流动的光点：每条路一组（跳与跳之间断开时拆成几段各一组） */
  comets: Array<{ key: string; tunnelId: number; path: CometPath; periodMs: number; count: number }>;
  /** 光点的相位按 key 记着，relayout 重算路径时接着跑，不从头来 */
  cometPhase: Map<string, number>;
  cometLast: number;
  /** 上一帧有没有往光点源里写过东西：停下来时要清一次，别留几颗不动的点 */
  cometDrawn: boolean;
  didInitialFit: boolean;
  /** 上一次框住的是哪些主机：集合变了才重新框 */
  fitSignature: string;
  /** 上一次布局里每个 marker 占的像素（精确框住用） */
  fitItems: FitItem[];
  /** 弧线采样点落在屏幕哪里：精确框住时弧顶也要在图里 */
  arcPx: PixelPoint[];
  /** 正在精确框住：中间几轮的相机跳动不算用户动过 */
  settling: boolean;
  /** 用户拖过 / 缩过、还没回到全览 —— 不再自动框 */
  userMoved: boolean;
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
      hostMarkers: new Map(), clusterMarkers: [], capMarkers: new Map(), countryMarkers: new Map(),
      layout: null, comets: [], cometPhase: new Map(), cometLast: 0, cometDrawn: false,
      didInitialFit: false, fitSignature: "", fitItems: [], arcPx: [], settling: false, userMoved: false,
      relayoutFrame: 0, animFrame: 0,
    };
  }
  const live = liveRef.current;
  live.props = props;

  const layoutPoints = (): LayoutPoint[] => live.props.model.nodes.flatMap((node) => (node.geo ? [{ key: `h${node.id}`, lngLat: [node.geo.lng, node.geo.lat] as LngLat }] : []));

  /** 要框住的主机集合（key 排序后拼起来）：变了才重新框，轮询回来同样的主机不动相机 */
  const fitSignature = () => layoutPoints().map((point) => point.key).sort().join("|");

  /** 主机现在画在哪：单独的是自己，并进组的是组心 */
  const drawnLngLat = (key: string): LngLat | null => live.layout?.pos[key]?.lngLat ?? null;

  // ---- marker 同步：按 id 复用元素，轮询回来的新模型只改变了的字，呼吸动画不会重新开始 ----
  const syncStaticMarkers = () => {
    const map = live.map;
    if (!map) return;
    const { model, hubHostId } = live.props;
    const seen = new Set<number>();
    for (const node of model.nodes) {
      if (!node.geo) continue;
      seen.add(node.id);
      const tone = nodeTone(model, node.id, hubHostId);
      const subline = hostSubline(tone, nodeLatency(model, node.id));
      const signature = [node.name, node.city, tone, subline].join("\u0001");
      let entry = live.hostMarkers.get(node.id);
      if (!entry) {
        const element = el(`<div class="nm-mk nm-mk-host" data-host="${node.id}"><button type="button" class="nm-mk-disc"><i class="nm-mk-pulse"></i><i class="nm-mk-glyph"></i></button><div class="nm-mk-name"><b class="nm-mk-city"></b><span class="nm-mk-lat"></span></div></div>`);
        const disc = element.querySelector(".nm-mk-disc") as HTMLButtonElement;
        disc.addEventListener("click", (event) => { event.stopPropagation(); live.props.onSelectNode(node.id); });
        const marker = new maplibregl.Marker({ element, anchor: "center" }).setLngLat([node.geo.lng, node.geo.lat]).addTo(map);
        entry = { marker, element, signature: "" };
        live.hostMarkers.set(node.id, entry);
      }
      if (entry.signature !== signature) {
        entry.signature = signature;
        const keep = entry.element.classList.contains("is-hidden") ? ["is-hidden"] : [];
        entry.element.className = ["nm-mk", "nm-mk-host", `is-${tone}`, ...keep].join(" ");
        const disc = entry.element.querySelector(".nm-mk-disc") as HTMLElement;
        disc.setAttribute("aria-label", [node.name, node.city !== node.name ? node.city : null, subline || null].filter(Boolean).join("，"));
        // 图上写城市（「东京」），主机名在点一下的提示和读屏文字里
        (entry.element.querySelector(".nm-mk-city") as HTMLElement).textContent = node.city;
        const lat = entry.element.querySelector(".nm-mk-lat") as HTMLElement;
        lat.textContent = subline;
        lat.hidden = !subline;
      }
    }
    for (const [id, entry] of live.hostMarkers) {
      if (seen.has(id)) continue;
      entry.marker.remove();
      live.hostMarkers.delete(id);
    }
    syncCountryLabels();
  };

  /**
   * 国家名：只给有主机（有坐标）的国家写一个，中文名，小而淡。标注点要等国界文件到了才知道，
   * 所以是异步建的；建好立刻按当前视图判断显不显示。
   */
  const syncCountryLabels = () => {
    const codes = new Set<string>();
    for (const node of live.props.model.nodes) {
      const code = node.geo && node.countryCode ? node.countryCode.toUpperCase() : "";
      if (code) codes.add(code);
    }
    void loadCountryAnchors().then((anchors) => {
      const map = live.map;
      if (!map) return;
      for (const [code, marker] of live.countryMarkers) {
        if (codes.has(code) && anchors.has(code)) continue;
        marker.remove();
        live.countryMarkers.delete(code);
      }
      for (const code of codes) {
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
   * 国名显不显示：放大到 6 级以上不写；压到主机、名字、⊗、组或角上的控件的也不写 —— 国名是最不要紧的
   * 那个字，谁都不让它挡。量的是 DOM 里的真实位置。
   */
  const updateCountryLabels = () => {
    const map = live.map;
    if (!map || live.countryMarkers.size === 0) return;
    const show = map.getZoom() < COUNTRY_LABEL_MAX_ZOOM;
    const container = map.getContainer();
    const frame = container.getBoundingClientRect();
    const scope = container.parentElement ?? container;
    const blockers: DOMRect[] = [];
    if (show) {
      for (const node of Array.from(scope.querySelectorAll(".nm-mk-disc, .nm-mk-pill, .nm-mk-name, .nm-mk-cap, .nm-reserved"))) {
        const element = node as HTMLElement;
        if (element.closest(".is-hidden") || element.classList.contains("is-off")) continue;
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
   * 名字的摆法（规则在 features/network/networkMapMini 的 placeLabelBoxes）：默认在环下面，压到别的名字、
   * 环、⊗、角上的小标签或露出边时翻到上面、左右挪、缩小字号、摆到旁边；两行摆不下就只留城市。
   * 量的是名字元素的真实宽度（它已经在 DOM 里）。顺手把每个 marker 真正占的像素记下来，精确框住用。
   */
  const placeLabels = (caps: Array<{ key: string; at: LngLat }>) => {
    const map = live.map;
    const layout = live.layout;
    if (!map || !layout) return;
    const container = map.getContainer();
    const width = container.clientWidth;
    const height = container.clientHeight;
    const area: PixelBox = { x: 0, y: 0, w: width, h: height };
    const resetName = (name: HTMLElement) => {
      name.classList.remove("is-up", "is-tight", "is-side", "is-short");
      name.style.marginLeft = "";
    };
    // 图外面老远的不参与摆名字：贴边的规则会把它的名字拖进图里来
    const farOutside = (at: PixelPoint) => at.x < -60 || at.y < -60 || at.x > width + 60 || at.y > height + 60;
    type Entry = { key: string; name: HTMLElement; body: PixelBox; gap: number };
    const entries: Entry[] = [];
    for (const [id, entry] of live.hostMarkers) {
      const position = layout.pos[`h${id}`];
      const name = entry.element.querySelector(".nm-mk-name") as HTMLElement | null;
      if (!position || !name) continue;
      // 并进组的主机不画自己的名字：把上一次的摆法清掉，散开时从头摆
      if (position.clusterId !== null) { resetName(name); continue; }
      const at = viewProject(map, position.lngLat);
      if (farOutside(at)) { resetName(name); continue; }
      entries.push({ key: `h${id}`, name, body: { x: at.x - DISC_R, y: at.y - DISC_R, w: DISC_R * 2, h: DISC_R * 2 }, gap: LABEL_GAP });
    }
    for (const cluster of live.clusterMarkers) {
      const element = cluster.marker.getElement();
      const pill = element.querySelector(".nm-mk-pill") as HTMLElement | null;
      const name = element.querySelector(".nm-mk-name") as HTMLElement | null;
      if (!pill || !name) continue;
      const at = viewProject(map, cluster.center);
      if (farOutside(at)) { resetName(name); continue; }
      const w = pill.offsetWidth || GROUP_R * 2;
      const h = pill.offsetHeight || GROUP_R * 2;
      entries.push({ key: `g${cluster.hostIds.join(",")}`, name, body: { x: at.x - w / 2, y: at.y - h / 2, w, h }, gap: h / 2 + 2 });
    }
    // 量名字：先按缩小一号的字号量一遍，再按正常的量；有延迟那行的再量一遍只剩城市一行的（两行摆不下时退成一行）
    const hasSubline = (entry: { name: HTMLElement }) => { const lat = entry.name.querySelector(".nm-mk-lat") as HTMLElement | null; return !!lat && !lat.hidden && !!lat.textContent; };
    for (const entry of entries) { entry.name.classList.remove("is-side", "is-short"); entry.name.classList.add("is-tight"); }
    const tightWidths = entries.map((entry) => entry.name.offsetWidth || 50);
    for (const entry of entries) if (hasSubline(entry)) entry.name.classList.add("is-short");
    const shortTight = entries.map((entry) => (hasSubline(entry) ? entry.name.offsetWidth || 50 : 0));
    for (const entry of entries) entry.name.classList.remove("is-tight");
    const shortSize = entries.map((entry) => (hasSubline(entry) ? { w: entry.name.offsetWidth || 50, h: entry.name.offsetHeight || 14 } : null));
    for (const entry of entries) { entry.name.classList.remove("is-short"); entry.name.style.marginLeft = ""; }
    const items: LabelItem[] = entries.map((entry, index) => ({
      key: entry.key, x: entry.body.x + entry.body.w / 2, y: entry.body.y + entry.body.h / 2,
      w: entry.name.offsetWidth || 60, h: entry.name.offsetHeight || 16, tightW: tightWidths[index], gap: entry.gap,
      // 城市下面的延迟那行只在摆得下时留着：两行怎么摆都压着别人就退成只写城市（延迟点开就有）
      ...(shortSize[index] ? { short: { w: shortSize[index]!.w, h: shortSize[index]!.h, tightW: shortTight[index] } } : {}),
      sideGap: entry.body.w / 2 + 3,
    }));
    // 障碍：环 / 组、线上的 ⊗、角上的小标签和 + / −（.nm-reserved）
    const obstacles: PixelBox[] = entries.map((entry) => entry.body);
    const capBoxes: PixelBox[] = [];
    for (const cap of caps) {
      const point = viewProject(map, cap.at);
      const button = live.capMarkers.get(cap.key)?.button;
      const w = button?.offsetWidth || 18;
      const h = button?.offsetHeight || 18;
      const box = { x: point.x - w / 2, y: point.y - h / 2, w, h };
      capBoxes.push(box);
      obstacles.push(box);
    }
    const frame = container.getBoundingClientRect();
    for (const reserved of Array.from(container.parentElement?.querySelectorAll(":scope > .nm-reserved") ?? [])) {
      const rect = reserved.getBoundingClientRect();
      obstacles.push({ x: rect.left - frame.left - 4, y: rect.top - frame.top - 4, w: rect.width + 8, h: rect.height + 8 });
    }
    const placements = new Map(placeLabelBoxes(items, obstacles, area).map((placement) => [placement.key, placement]));
    const fitItems: FitItem[] = [];
    const center = (box: PixelBox): PixelPoint => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
    for (const entry of entries) {
      const placement = placements.get(entry.key);
      if (!placement) continue;
      entry.name.classList.toggle("is-up", placement.up);
      // 摆到环旁边：CSS 把名字竖直居中在锚点上，marginLeft 是名字左边缘离锚点多远
      entry.name.classList.toggle("is-side", !!placement.side);
      entry.name.classList.toggle("is-tight", placement.tight);
      entry.name.classList.toggle("is-short", !!placement.short);
      entry.name.style.marginLeft = placement.dx ? `${placement.dx}px` : "";
      fitItems.push({ anchor: center(entry.body), box: unionBox([entry.body, placement.box])! });
    }
    for (const box of capBoxes) fitItems.push({ anchor: center(box), box });
    // 弧线也得在图里：只会让框得更松，不会为了弧线裁掉 marker
    for (const point of live.arcPx) fitItems.push({ anchor: point, box: { x: point.x - 2, y: point.y - 2, w: 4, h: 4 } });
    live.fitItems = fitItems;
  };

  /**
   * 精确框住：fitBounds 只知道经纬度，不知道环和名字有多宽，贴边的主机会被裁掉半个环。
   * 这里量一遍每个 marker 真正占的像素，算出该缩放多少、中心挪到哪（fitViewToBoxes），跳过去，
   * 再量一遍 —— 缩放变了分组会变（两台并成一组、名字翻到另一侧），几轮就收敛。头两轮允许
   * 往里放大（空着的地方别浪费，最多到 9 级），之后只缩不放，量到什么都没出界、也不用再挪才停。
   */
  const settleFit = () => {
    const map = live.map;
    if (!map || !live.loaded) return;
    const container = map.getContainer();
    const size = { width: container.clientWidth, height: container.clientHeight };
    if (size.width < 40 || size.height < 40) return;
    // 上一次框好之后把 minZoom 抬到了「再缩一级」，这次框可能要更小：先放开
    map.setMinZoom(0);
    const c0 = { x: size.width / 2, y: size.height / 2 };
    live.settling = true;
    try {
      for (let round = 0; round < 6; round += 1) {
        relayout();
        const zoom = map.getZoom();
        const maxZoom = round < 2 ? MINI_FIT_MAX_ZOOM : zoom;
        const fit = fitViewToBoxes(size, live.fitItems, FIT_INSET, { maxScale: 2 ** (maxZoom - zoom), minScale: 2 ** (0 - zoom) });
        if (!fit) break;
        if (Math.abs(fit.zoomDelta) < 0.004 && Math.hypot(fit.centerPx.x - c0.x, fit.centerPx.y - c0.y) < 0.75) break;
        map.jumpTo({ center: map.unproject([fit.centerPx.x, fit.centerPx.y]), zoom: zoom + fit.zoomDelta });
      }
      relayout();
    } finally {
      live.settling = false;
    }
    // 用户最多能缩到框好的再小一级
    map.setMinZoom(miniMinZoom(map.getZoom()));
  };

  /** 用户拖过 / 缩过、还是回到了全览：变了才告诉卡片 */
  const setUserMoved = (moved: boolean) => {
    if (live.userMoved === moved) return;
    live.userMoved = moved;
    live.props.onUserMovedChange(moved);
  };

  /** ⊗ 挂在弧线的哪个点上：默认正中；压到主机的环 / 组、已经挂好的别的 ⊗ 时沿着弧线往两头挪 */
  const capPointIndex = (points: LngLat[], key: string, avoid: readonly PixelBox[]): number => {
    const map = live.map;
    const middle = Math.floor(points.length / 2);
    if (!map || avoid.length === 0) return middle;
    const container = map.getContainer();
    const width = container.clientWidth;
    const height = container.clientHeight;
    const button = live.capMarkers.get(key)?.button;
    const w = button?.offsetWidth || 18;
    const h = button?.offsetHeight || 18;
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

  /** 点一组：把这组的主机框进画面（往组心飞固定几级会把组里离得远的甩出去，所以按组员的坐标框） */
  const zoomToGroup = (hostIds: number[], center: LngLat) => {
    const map = live.map;
    if (!map) return;
    const points = hostIds.flatMap((id) => {
      const node = live.props.model.nodes.find((item) => item.id === id);
      return node?.geo ? [[node.geo.lng, node.geo.lat] as LngLat] : [];
    });
    const bounds = points.length > 1 ? boundsForPoints(points) : null;
    const duration = live.props.reduceMotion ? 0 : 900;
    setUserMoved(true);
    // 坐标完全相同的几台框不开（还是一枚带数量的环）：那就往组心放大几级
    if (bounds) map.fitBounds(bounds, { maxZoom: GROUP_FIT.maxZoom, padding: GROUP_FIT.padding, duration, essential: true });
    else map.easeTo({ center: center as [number, number], zoom: Math.max(6.3, map.getZoom() + 2.2), duration, essential: true });
  };

  // ---- 布局：并组，再把线、箭头、⊗ 挂上去 ----
  const relayout = () => {
    const map = live.map;
    if (!map || !live.loaded || !map.getSource(NETWORK_MAP_SOURCES.links)) return;
    const { model, hubHostId } = live.props;
    const zoom = map.getZoom();
    // 环会压在一起的并成一组（每台都在真实坐标上，不错开）
    const flagOf = new Map(model.nodes.map((node) => [`h${node.id}`, node.emoji]));
    live.layout = computeMapLayout(layoutPoints(), (lngLat) => map.project(lngLat as [number, number]), miniGroupLayoutOptions(flagOf));
    const layout = live.layout;
    for (const [id, entry] of live.hostMarkers) {
      const position = layout.pos[`h${id}`];
      if (!position) continue;
      entry.element.classList.toggle("is-hidden", position.clusterId !== null);
      entry.marker.setLngLat(position.lngLat as [number, number]);
    }
    for (const cluster of live.clusterMarkers) cluster.marker.remove();
    live.clusterMarkers = [];
    const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
    for (const group of layout.groups) {
      const hostIds: number[] = [];
      const cities: string[] = [];
      let tone: NodeTone = "ok";
      let rank = TONE_RANK.ok;
      for (const key of group.keys) {
        const node = nodeById.get(Number(key.slice(1)));
        if (!node) continue;
        hostIds.push(node.id);
        cities.push(node.city);
        const nodeToneValue = nodeTone(model, node.id, hubHostId);
        // 枢纽在组里：组画成枢纽的蓝（除非组里有人出了问题）
        if (nodeToneValue === "hub") { if (rank >= TONE_RANK.ok) { tone = "hub"; rank = TONE_RANK.ok; } }
        else if (TONE_RANK[nodeToneValue] < rank) { rank = TONE_RANK[nodeToneValue]; tone = nodeToneValue; }
      }
      const label = groupPlaceLabel(cities);
      // 一组：一枚大一号的发光环，里面写几台；组里最该被看到的那个颜色画在环上；下面写这几台的城市
      const element = el(`<div class="nm-mk nm-mk-cluster is-${tone}"><button type="button" class="nm-mk-pill" aria-label="${escapeHtml(label)}，${hostIds.length} 台，点击放大"><b class="nm-mk-count">${hostIds.length}</b></button><div class="nm-mk-name"><b class="nm-mk-city">${escapeHtml(label)}</b></div></div>`);
      const center = group.center;
      (element.firstElementChild as HTMLElement).addEventListener("click", (event) => {
        event.stopPropagation();
        zoomToGroup(hostIds, center);
        live.props.onSelectGroup(hostIds, label);
      });
      const marker = new maplibregl.Marker({ element, anchor: "center" }).setLngLat(center as [number, number]).addTo(map);
      live.clusterMarkers.push({ marker, hostIds, center, label });
    }

    // 线：每一跳一条大圆弧；两端在同一组里就不画（组已经说明它们在一起）
    const linkFeatures: any[] = [];
    const arrowFeatures: any[] = [];
    const waypointFeatures: any[] = [];
    const caps: Array<{ key: string; at: LngLat; tunnelId: number; label: string }> = [];
    // ⊗ 要躲开的：每台主机的环、每一组，和先挂好的 ⊗
    const capAvoid: PixelBox[] = [];
    for (const position of Object.values(layout.pos)) {
      if (position.clusterId !== null) continue;
      const at = viewProject(map, position.lngLat);
      capAvoid.push({ x: at.x - DISC_R, y: at.y - DISC_R, w: DISC_R * 2, h: DISC_R * 2 });
    }
    for (const group of layout.groups) {
      const at = viewProject(map, group.center);
      capAvoid.push({ x: at.x - GROUP_R - 3, y: at.y - GROUP_R - 3, w: GROUP_R * 2 + 6, h: GROUP_R * 2 + 6 });
    }
    const unitsPerPixel = mercatorUnitsPerPixel(zoom);
    const comets: Live["comets"] = [];
    const arcPx: PixelPoint[] = [];
    /*
      同一对主机之间不止一条线（主线路和它的备用隧道、一来一回两条隧道）：同一条大圆弧上叠好几条，
      虚线压在实线上根本看不出来。第二条起往两边各弯开一点（屏幕上 14px 一档），弯的方向按主机 id
      小的那头定，一来一回的两条不会弯到同一边。
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
    for (const link of model.links) {
      const hosts = link.path;
      const kind: LineKind = link.kind;
      const capIndex = Math.floor((hosts.length - 2) / 2);
      // 主线路跑光点：把画出来的各跳首尾相接；中间有一跳没画（两端同组）就断开成两段
      let hopRun: LngLat[][] = [];
      let hopRunStart = 0;
      const flush = () => {
        const path = hopRun.length > 0 ? buildCometPath(hopRun) : null;
        if (path) {
          const screen = path.total / unitsPerPixel;
          comets.push({ key: `t:${link.id}:${hopRunStart}`, tunnelId: link.id, path, periodMs: cometPeriodMs(screen), count: screen >= PARTICLES_LONG_PX ? PARTICLES_LONG : PARTICLES_SHORT });
        }
        hopRun = [];
      };
      for (let index = 0; index < hosts.length - 1; index += 1) {
        const keyA = `h${hosts[index]}`;
        const keyB = `h${hosts[index + 1]}`;
        const posA = layout.pos[keyA];
        const posB = layout.pos[keyB];
        if (!posA || !posB || (posA.clusterId !== null && posA.clusterId === posB.clusterId)) { flush(); continue; }
        const a = drawnLngLat(keyA);
        const b = drawnLngLat(keyB);
        if (!a || !b) { flush(); continue; }
        const points = bend(greatCircleArc(a, b), hosts[index], hosts[index + 1]);
        // 虚线按主机 id 小的那头起笔：同一跳上一来一回的两条虚线相位对得上、重成一条，
        // 不然两套错开的虚线叠成一串拉链。主线路的渐变要入口 → 出口，不能翻；光点、箭头照用原方向
        const linePoints = kind !== "main" && hosts[index] > hosts[index + 1] ? [...points].reverse() : points;
        linkFeatures.push({ type: "Feature", properties: { tunnel: link.id, kind }, geometry: { type: "LineString", coordinates: linePoints } });
        if (kind === "main") { if (hopRun.length === 0) hopRunStart = index; hopRun.push(points); }
        // 备用线路经过的中转：一颗灰色小点（主机的环盖住它；并进组时它还在，看得出线是在这儿拐的）
        if (kind === "backup" && index < hosts.length - 2) waypointFeatures.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: b } });
        // 弧线每隔几个点记一下落在屏幕哪里：精确框住时弧顶也要在图里
        for (let k = 0; k < points.length; k += 4) arcPx.push(viewProject(map, points[k]));
        // 出口端的箭头（最后一跳的末端）：按屏幕像素算三角形，箭尖退到环的边缘外面，再换回经纬度
        if (index === hosts.length - 2) {
          const projected = points.map((point) => map.project(point as [number, number]));
          const triangle = arrowTriangleAlong(projected, ARROW.size, posB.clusterId !== null ? ARROW.backoffGroup : ARROW.backoffHost, undefined, ARROW.widthRatio);
          if (triangle) {
            const ref = points[points.length - 1][0];
            const ring = triangle.map((corner) => {
              const at = map.unproject([corner.x, corner.y]);
              return [at.lng + Math.round((ref - at.lng) / 360) * 360, at.lat];
            });
            ring.push(ring[0]);
            arrowFeatures.push({ type: "Feature", properties: { kind }, geometry: { type: "Polygon", coordinates: [ring] } });
          }
        }
        // 中断的线正中一个 ⊗；两端在屏幕上挨得太近时会盖住环，线短到放不下就不挂
        const pa = viewProject(map, points[0]);
        const pb = viewProject(map, points[points.length - 1]);
        if (kind !== "down" || index !== capIndex || Math.hypot(pa.x - pb.x, pa.y - pb.y) < MINI_CAP_MIN_ARC_PX) continue;
        const key = `b:${link.id}`;
        const at = points[capPointIndex(points, key, capAvoid)];
        caps.push({ key, at, tunnelId: link.id, label: link.name });
        const point = viewProject(map, at);
        capAvoid.push({ x: point.x - 11, y: point.y - 11, w: 22, h: 22 });
      }
      flush();
    }
    live.comets = comets;
    live.arcPx = arcPx;
    for (const key of Array.from(live.cometPhase.keys())) if (!comets.some((comet) => comet.key === key)) live.cometPhase.delete(key);
    (map.getSource(NETWORK_MAP_SOURCES.links) as GeoJSONSource).setData({ type: "FeatureCollection", features: linkFeatures });
    (map.getSource(NETWORK_MAP_SOURCES.arrows) as GeoJSONSource).setData({ type: "FeatureCollection", features: arrowFeatures });
    (map.getSource(NETWORK_MAP_SOURCES.waypoints) as GeoJSONSource).setData({ type: "FeatureCollection", features: waypointFeatures });

    // 线上的 ⊗：按 key 复用
    const seenCaps = new Set<string>();
    for (const cap of caps) {
      seenCaps.add(cap.key);
      let entry = live.capMarkers.get(cap.key);
      if (!entry) {
        // marker 元素本身会被 MapLibre 写 transform 定位，所以按钮套在一个 0×0 的壳里，
        // 自己再用 translate(-50%, -50%) 居中；直接把按钮当 marker 元素，它的居中会被盖掉
        const element = el(`<div class="nm-mk"><button type="button" class="nm-mk-cap">${BREAK_ICON}</button></div>`);
        const button = element.firstElementChild as HTMLButtonElement;
        button.addEventListener("click", (event) => { event.stopPropagation(); const current = live.capMarkers.get(cap.key); if (current) live.props.onSelectLink(current.tunnelId); });
        const marker = new maplibregl.Marker({ element, anchor: "center" }).setLngLat(cap.at as [number, number]).addTo(map);
        entry = { marker, element, button, tunnelId: cap.tunnelId };
        live.capMarkers.set(cap.key, entry);
      } else entry.marker.setLngLat(cap.at as [number, number]);
      entry.tunnelId = cap.tunnelId;
      entry.button.setAttribute("aria-label", `${cap.label} 中断`);
    }
    for (const [key, entry] of live.capMarkers) {
      if (seenCaps.has(key)) continue;
      entry.marker.remove();
      live.capMarkers.delete(key);
    }
    placeLabels(caps);
    // 国名最后摆：环、组、⊗、名字都就位了才知道它会不会压到谁
    updateCountryLabels();
  };

  const scheduleRelayout = () => {
    if (live.relayoutFrame) return;
    live.relayoutFrame = requestAnimationFrame(() => { live.relayoutFrame = 0; relayout(); });
  };

  // ---- 相机 ----
  const api: NetworkMapCameraApi = {
    fitAll() {
      const map = live.map;
      if (!map) return;
      // 不管是首次、卡片变宽、主机集合变了还是「回到全览」，框住全部就是回到了自动的视角
      setUserMoved(false);
      const points = layoutPoints().map((point) => point.lngLat);
      if (points.length === 0) { map.jumpTo({ center: [110, 25], zoom: 1.6 }); return; }
      // 大圆弧往高纬度弯出去的那一段也得框进来，不然日美那条线的弧顶一打开就在卡片外面
      const nodeById = new Map(live.props.model.nodes.map((node) => [node.id, node]));
      for (const link of live.props.model.links) {
        for (let index = 0; index < link.path.length - 1; index += 1) {
          const a = nodeById.get(link.path[index])?.geo;
          const b = nodeById.get(link.path[index + 1])?.geo;
          if (a && b) points.push(...greatCircleArc([a.lng, a.lat], [b.lng, b.lat], 12));
        }
      }
      const bounds = boundsForPoints(points);
      if (!bounds) return;
      // 直接跳过去不飞（卡片刚出现 / 主机集合变了 / 卡片变宽了，飞一下反而像出了错），最多放到 9 级；
      // fitBounds 只是粗放，随后 settleFit 按 marker 真正占的像素精确框一遍
      map.fitBounds(bounds, { maxZoom: MINI_FIT_MAX_ZOOM, padding: FIT_PADDING, duration: 0 });
      settleFit();
    },
    zoomBy(delta) {
      const map = live.map;
      if (!map) return;
      setUserMoved(true);
      const zoom = Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), map.getZoom() + delta));
      map.easeTo({ zoom, duration: live.props.reduceMotion ? 0 : 240, essential: true });
    },
  };

  /** 要不要重新框（规则在 shouldRefit）：用户动过图就只重新摆一遍，不抢视角 */
  const refit = (trigger: MiniFitTrigger) => {
    if (shouldRefit(trigger, live.userMoved)) api.fitAll();
    else relayout();
  };

  // ---- 动画：主线路上的光点每帧按相位采样一次写进 GeoJSON 源（≤ 几十条线，一帧百来个点，便宜）。
  //      每条路两三颗，均匀错开、首尾相接一直流 —— 说的是「这条线上有流量在往出口走」。
  //      页面不可见 / 卡片滚出视野 / 减少动态时全停 ----
  const clearComets = () => {
    const map = live.map;
    if (!map || !live.loaded || !live.cometDrawn) return;
    (map.getSource(NETWORK_MAP_SOURCES.particles) as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] });
    live.cometDrawn = false;
  };
  const tickAnimation = (timestamp: number) => {
    const map = live.map;
    const running = live.loaded && !live.props.paused && !live.props.reduceMotion && document.visibilityState === "visible";
    if (map && running && live.comets.length > 0) {
      const source = map.getSource(NETWORK_MAP_SOURCES.particles) as GeoJSONSource | undefined;
      if (source) {
        const dt = live.cometLast ? Math.min(COMET_MAX_FRAME_MS, timestamp - live.cometLast) : 0;
        const features: any[] = [];
        for (const comet of live.comets) {
          // 每条线错开出发时刻（按 id 和 key 取相位），不然所有光点齐刷刷一起走
          const phase = advanceCometPhase(live.cometPhase.get(comet.key) ?? ((comet.tunnelId * 0.37 + comet.key.length * 0.113) % 1), dt, comet.periodMs);
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

  /** 面板切了主题：地图本身永远深色，但强调色这些令牌可能跟着变 —— 从 CSS 变量里再读一遍 */
  const applySkinColors = () => {
    const map = live.map;
    if (!map || !live.loaded) return;
    const holder = containerRef.current?.parentElement ?? null;
    live.colors = readColors(holder);
    const base = readBaseColors(holder);
    const colors = live.colors;
    map.setPaintProperty(NETWORK_MAP_LAYERS.background, "background-color", base.water);
    map.setPaintProperty(NETWORK_MAP_LAYERS.land, "fill-color", base.land);
    map.setPaintProperty(NETWORK_MAP_LAYERS.borders, "line-color", base.border);
    const expression = kindColorExpression(colors);
    for (const layer of [NETWORK_MAP_LAYERS.linkGlow, NETWORK_MAP_LAYERS.linkDashed]) map.setPaintProperty(layer, "line-color", expression);
    map.setPaintProperty(NETWORK_MAP_LAYERS.linkMain, "line-gradient", linkGradient(colors));
    map.setPaintProperty(NETWORK_MAP_LAYERS.arrows, "fill-color", ["match", ["get", "kind"], "main", lighten(colors.main, 0.4), "degraded", colors.degraded, "down", colors.down, colors.backup]);
    map.setPaintProperty(NETWORK_MAP_LAYERS.waypoints, "circle-color", colors.backup);
    map.setPaintProperty(NETWORK_MAP_LAYERS.waypoints, "circle-stroke-color", base.water);
    map.setPaintProperty(NETWORK_MAP_LAYERS.particleGlow, "circle-color", colors.main);
    map.setPaintProperty(NETWORK_MAP_LAYERS.particleCore, "circle-color", colors.particle);
  };

  // ---- 创建地图（只一次）----
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    live.colors = readColors(container.parentElement);
    const baseColors = readBaseColors(container.parentElement);
    // 夜光地球图的瓦片协议（全局注册一次）
    registerEarthTiles();
    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container,
        style: buildNetworkMapStyle(COUNTRIES_URL, live.colors, baseColors) as any,
        center: [110, 25],
        zoom: 1.6,
        // 340px 宽的手机卡片里要框住横跨太平洋的线，0.5 级放不下（世界 724px 宽），放开到 0 级
        minZoom: 0,
        maxZoom: 14,
        attributionControl: false,
        renderWorldCopies: true,
        pitchWithRotate: false,
        dragRotate: false,
        touchPitch: false,
        fadeDuration: 0,
        // 能拖、捏合缩放、双击放大；滚轮不缩（滚到卡片上页面还得能往下滚，缩放用角上的 + / −）、
        // 键盘不管（卡片不是焦点）
        scrollZoom: false,
        keyboard: false,
      });
    } catch (error) {
      // 没有 WebGL（远程桌面、老浏览器）：卡片退回示意图
      console.error("[NetworkMap] 地图引擎起不来", error);
      live.props.onUnavailable();
      return undefined;
    }
    live.map = map;
    map.touchZoomRotate.disableRotation();
    // 初始化挂在 style.load 而不是 load 上：load 要等所有源都「到达终态」之后的下一帧才发，地球图的
    // 瓦片报错不会再触发重绘，load 就可能永远不来，图上一个点都没有。style.load 只看样式本身，
    // 源都已建好，setData / 改图层属性这时都能用；marker 本来就不依赖样式。
    map.once("style.load", () => {
      live.loaded = true;
      syncStaticMarkers();
      relayout();
      if (!live.didInitialFit && layoutPoints().length > 0) { live.didInitialFit = true; live.fitSignature = fitSignature(); api.fitAll(); }
      // 拖图、缩放时环、名字、箭头、⊗ 的躲让都得跟着（每帧一次 rAF 合并的重排）；动画最后一帧的事件
      // 可能撞上数据源还在重算，moveend / zoomend 再算一次兜底
      map.on("move", scheduleRelayout);
      map.on("zoom", scheduleRelayout);
      map.on("moveend", relayout);
      map.on("zoomend", relayout);
      // 只有用户手上的动作算「动过」：jumpTo / fitBounds / easeTo 发的事件没有 originalEvent
      map.on("dragstart", (event) => { if (event.originalEvent && !live.settling) setUserMoved(true); });
      map.on("zoomstart", (event) => { if (event.originalEvent && !live.settling) setUserMoved(true); });
      map.on("click", (event) => {
        // 点在线上（看不见的命中层有 14px 宽，好点）就当点了这条线；点空处什么都不做
        const { x, y } = event.point;
        const hit = map.queryRenderedFeatures([[x - 4, y - 4], [x + 4, y + 4]], { layers: [NETWORK_MAP_LAYERS.linkHit] })[0];
        const tunnelId = Number(hit?.properties?.tunnel) || 0;
        if (tunnelId > 0) live.props.onSelectLink(tunnelId);
      });
      live.animFrame = requestAnimationFrame(tickAnimation);
      live.props.onReady(api);
    });
    map.on("error", (event: any) => {
      // 地球图的瓦片拉不下来（离线、被拦）：图照画，只是没有夜景 —— 不刷屏。别的错误（样式、我们自己
      // 的事件处理函数抛的）还是要看得见，否则图上少了东西没人知道为什么
      const sourceId = event?.sourceId || event?.source?.id;
      if (sourceId === NETWORK_MAP_SOURCES.night || (event?.tile && !sourceId)) return;
      console.error("[NetworkMap]", event?.error || event);
    });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
      map.resize();
      // 卡片变宽变窄（转屏、侧栏收起）就重新框一遍，不然一半主机跑到边外；用户动过图就不抢视角
      if (live.loaded && live.didInitialFit) refit("resize");
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
      live.capMarkers.clear();
      live.clusterMarkers = [];
      live.countryMarkers.clear();
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 模型变了：同步 marker，重新布线；主机多了一台 / 少了一台就重新框（用户动过图就不抢）----
  useEffect(() => {
    if (!live.loaded) return;
    syncStaticMarkers();
    relayout();
    if (!live.didInitialFit && layoutPoints().length > 0) { live.didInitialFit = true; live.fitSignature = fitSignature(); api.fitAll(); return; }
    if (live.didInitialFit) {
      const signature = fitSignature();
      if (signature !== live.fitSignature) { live.fitSignature = signature; refit("hosts"); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.model]);

  // ---- 面板切了主题：颜色令牌可能跟着变，等这一帧新主题落到 DOM 上再读 ----
  useEffect(() => {
    if (!live.map || !live.loaded) return;
    requestAnimationFrame(applySkinColors);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.skin]);

  // 枢纽换了：环和组的颜色跟着换
  useEffect(() => {
    if (!live.loaded) return;
    syncStaticMarkers();
    relayout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.hubHostId]);

  useEffect(() => {
    // 减少动态效果：光点停，主线路的渐变和出口的箭头还在，方向照样看得出
    if (props.reduceMotion) clearComets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.reduceMotion]);

  return <div ref={containerRef} className="nm-map" aria-label="网络地图：主机与线路" />;
}
