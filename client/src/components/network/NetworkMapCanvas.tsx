import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type Marker } from "maplibre-gl";
import { isCountryCodeLabel } from "@/lib/flagEmojiSupport";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";

import type { NetworkMapModel, NetworkMapTarget } from "@/features/network/networkMapModel";
import { isClusterDimmed, isFlowDimmed, isHostDimmed, isTargetDimmed, isTunnelDimmed, type MapFocus, type MapPadding } from "@/features/network/networkMapPageState";
import { wgs84ToGcj02 } from "@shared/gcj02";
import { NETWORK_MAP_BASE_LAYERS, type NetworkMapBaseLayerId } from "@shared/networkMapBaseLayers";
import { boundsForPoints, computeMapLayout, greatCircleArc, type LayoutPoint, type LngLat, type MapLayout } from "@shared/networkMapGeometry";
import { describeNetworkHealth, type NetworkHealth } from "@shared/networkHealth";

import { readCssColor } from "./mapCharts";
import {
  NETWORK_MAP_DASH_INTERVAL_MS,
  NETWORK_MAP_DASH_STEPS,
  NETWORK_MAP_LAYERS,
  NETWORK_MAP_SOURCES,
  baseLayerPaintPatch,
  buildNetworkMapStyle,
  healthColorExpression,
  rasterSourceIds,
  type NetworkMapLineColors,
  type NetworkMapLineHealth,
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
 * 高德底图下每个点先过 WGS-84 → GCJ-02（shared/gcj02.ts），暗黑网格用 Natural Earth
 * 的国界（WGS-84）不转 —— 所以坐标转换在这里做、按当前底图做，模型里存的永远是原始坐标。
 */

export type NetworkMapCameraApi = {
  flyTo(lngLat: LngLat, zoom: number): void;
  fitPoints(points: LngLat[], maxZoom?: number): void;
  fitAll(): void;
  /** 一台主机 / 一个目标当前画在哪（原始坐标；没画出来是 null） */
  hostLngLat(hostId: number): LngLat | null;
  targetLngLat(key: string): LngLat | null;
  getZoom(): number;
};

export type NetworkMapCanvasProps = {
  model: NetworkMapModel;
  baseLayer: NetworkMapBaseLayerId;
  focus: MapFocus | null;
  showFlows: boolean;
  padding: MapPadding;
  reduceMotion: boolean;
  /** 页面不可见 / 地图被盖住时停掉流动光点 */
  paused: boolean;
  onSelectNode: (hostId: number) => void;
  onSelectLink: (tunnelId: number) => void;
  onSelectTarget: (key: string) => void;
  onSelectCluster: (center: LngLat, zoom: number) => void;
  onMapClick: () => void;
  /** 高德瓦片拉不下来（内网、被墙、断网）时叫一次 */
  onRasterError: () => void;
  /** 建不出 WebGL 上下文（远程桌面、老浏览器、被禁用了硬件加速）：页面画兜底文案 */
  onUnavailable: () => void;
  onReady: (api: NetworkMapCameraApi) => void;
};

const COUNTRIES_URL = "/globe/ne_110m_admin_0_countries.geojson";

/** 暗黑网格没有瓦片标注，缩小时给几个国家名定个位 */
const COUNTRY_LABELS: Array<[string, number, number]> = [
  ["中国", 103, 36], ["日本", 138.5, 37], ["蒙古", 104, 47], ["印度", 79, 22], ["俄罗斯", 100, 62],
  ["澳大利亚", 134, -25], ["印度尼西亚", 114, -3], ["美国", -100, 40], ["加拿大", -105, 58], ["巴西", -53, -10],
  ["菲律宾", 122.5, 12.5], ["欧洲", 15, 50], ["非洲", 20, 5],
];

/** 框住几个点时在地图留白之外再让出的边：marker 下面的名字和备注有百来像素宽，贴边会被裁掉半截 */
const FIT_PADDING = { top: 36, bottom: 36, left: 64, right: 64 };

/** 一跳的两端在屏幕上至少隔这么远才挂延迟胶囊 */
const CAP_MIN_ARC_PX = 110;

const FALLBACK_COLORS: NetworkMapLineColors = { healthy: "#06b6d4", warn: "#f59e0b", down: "#ef4444", standby: "#94a3b8" };

function lineHealth(health: NetworkHealth): NetworkMapLineHealth {
  const token = describeNetworkHealth(health).token;
  if (token === "healthy") return "healthy";
  if (token === "warn" || token === "path") return "warn";
  if (token === "down") return "down";
  return "standby";
}

function healthClass(health: NetworkHealth) {
  const line = lineHealth(health);
  return line === "healthy" ? "is-ok" : line === "warn" ? "is-warn" : line === "down" ? "is-down" : "is-standby";
}

function worstHealth(list: NetworkHealth[]): NetworkHealth {
  let worst: NetworkHealth = "healthy";
  for (const health of list) {
    const line = lineHealth(health);
    if (line === "down") return "down";
    if (line === "warn") worst = "degraded";
    else if (line === "standby" && worst === "healthy") worst = "standby";
  }
  return worst;
}

function readColors(container: HTMLElement | null): NetworkMapLineColors {
  return {
    healthy: readCssColor(container, "--nm-link", FALLBACK_COLORS.healthy),
    warn: readCssColor(container, "--nm-warn", FALLBACK_COLORS.warn),
    down: readCssColor(container, "--nm-down", FALLBACK_COLORS.down),
    standby: readCssColor(container, "--nm-standby", FALLBACK_COLORS.standby),
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

type HostMarkerEntry = { marker: Marker; element: HTMLElement; signature: string };
type TargetMarkerEntry = { marker: Marker; element: HTMLElement; signature: string };
type CapEntry = { marker: Marker; element: HTMLElement; button: HTMLButtonElement };

type Live = {
  props: NetworkMapCanvasProps;
  map: MapLibreMap | null;
  loaded: boolean;
  colors: NetworkMapLineColors;
  hostMarkers: Map<number, HostMarkerEntry>;
  targetMarkers: Map<string, TargetMarkerEntry>;
  clusterMarkers: Array<{ marker: Marker; members: Array<{ kind: "host"; id: number } | { kind: "target"; key: string }> }>;
  capMarkers: Map<number, CapEntry>;
  stubMarkers: Map<number, Marker>;
  countryMarkers: Marker[];
  layout: MapLayout | null;
  linkFeatureIds: Array<{ fid: string; tunnelId: number }>;
  flowFeatureIds: Array<{ fid: string; targetKey: string; ruleIds: number[] }>;
  didInitialFit: boolean;
  rasterErrorReported: boolean;
  relayoutFrame: number;
  dashFrame: number;
  dashStep: number;
  dashLast: number;
};

export default function NetworkMapCanvas(props: NetworkMapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const liveRef = useRef<Live | null>(null);
  if (!liveRef.current) {
    liveRef.current = {
      props, map: null, loaded: false, colors: FALLBACK_COLORS,
      hostMarkers: new Map(), targetMarkers: new Map(), clusterMarkers: [], capMarkers: new Map(), stubMarkers: new Map(), countryMarkers: [],
      layout: null, linkFeatureIds: [], flowFeatureIds: [], didInitialFit: false, rasterErrorReported: false,
      relayoutFrame: 0, dashFrame: 0, dashStep: 0, dashLast: 0,
    };
  }
  const live = liveRef.current;
  live.props = props;

  // ---- 坐标：底图决定转不转 ----
  const display = (lngLat: LngLat): LngLat => (NETWORK_MAP_BASE_LAYERS[live.props.baseLayer].amap ? wgs84ToGcj02(lngLat[0], lngLat[1]) : lngLat);

  const layoutPoints = (): LayoutPoint[] => {
    const { model, showFlows } = live.props;
    const points: LayoutPoint[] = [];
    for (const node of model.nodes) if (node.geo) points.push({ key: `h${node.id}`, lngLat: display([node.geo.lng, node.geo.lat]) });
    if (showFlows) for (const target of model.targets) if (target.geo) points.push({ key: `t:${target.key}`, lngLat: display([target.geo.lng, target.geo.lat]) });
    return points;
  };

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
    const seenHosts = new Set<number>();
    for (const node of model.nodes) {
      if (!node.geo) continue;
      seenHosts.add(node.id);
      const signature = [node.name, node.note, node.health, node.emoji].join("\u0001");
      let entry = live.hostMarkers.get(node.id);
      if (!entry) {
        const element = el(`<div class="nm-mk nm-mk-host" data-host="${node.id}"><button type="button" class="nm-mk-disc"></button><div class="nm-mk-name"></div><div class="nm-mk-note nm-num"></div></div>`);
        const disc = element.querySelector(".nm-mk-disc") as HTMLButtonElement;
        disc.addEventListener("click", (event) => { event.stopPropagation(); live.props.onSelectNode(node.id); });
        const marker = new maplibregl.Marker({ element, anchor: "center" }).setLngLat(display([node.geo.lng, node.geo.lat])).addTo(map);
        entry = { marker, element, signature: "" };
        live.hostMarkers.set(node.id, entry);
      }
      if (entry.signature !== signature) {
        entry.signature = signature;
        entry.element.className = `nm-mk nm-mk-host ${healthClass(node.health)}`;
        const disc = entry.element.querySelector(".nm-mk-disc") as HTMLElement;
        disc.setAttribute("aria-label", `${node.name}${node.note ? `，${node.note}` : ""}`);
        disc.innerHTML = node.emoji ? `<span${isCountryCodeLabel(node.emoji) ? ' class="nm-mk-code"' : ""}>${escapeHtml(node.emoji)}</span>` : `<span class="nm-mk-flag-dot"></span>`;
        (entry.element.querySelector(".nm-mk-name") as HTMLElement).textContent = node.name;
        (entry.element.querySelector(".nm-mk-note") as HTMLElement).textContent = node.note || "";
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
        const signature = [target.city, target.health, target.emoji].join("\u0001");
        let entry = live.targetMarkers.get(target.key);
        if (!entry) {
          const element = el(`<div class="nm-mk nm-mk-target"><i role="button" tabindex="0"></i><div class="nm-mk-name"></div></div>`);
          const diamond = element.querySelector("i") as HTMLElement;
          diamond.addEventListener("click", (event) => { event.stopPropagation(); live.props.onSelectTarget(target.key); });
          diamond.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); live.props.onSelectTarget(target.key); } });
          const marker = new maplibregl.Marker({ element, anchor: "center" }).setLngLat(display([target.geo.lng, target.geo.lat])).addTo(map);
          entry = { marker, element, signature: "" };
          live.targetMarkers.set(target.key, entry);
        }
        if (entry.signature !== signature) {
          entry.signature = signature;
          entry.element.className = `nm-mk nm-mk-target ${healthClass(target.health)}`;
          (entry.element.querySelector("i") as HTMLElement).setAttribute("aria-label", `落地目标 ${target.address}`);
          (entry.element.querySelector(".nm-mk-name") as HTMLElement).textContent = target.emoji ? `${target.emoji} ${target.city}` : target.city;
        }
      }
    }
    for (const [key, entry] of live.targetMarkers) {
      if (seenTargets.has(key)) continue;
      entry.marker.remove();
      live.targetMarkers.delete(key);
    }
    if (live.countryMarkers.length === 0) {
      for (const [label, lng, lat] of COUNTRY_LABELS) {
        const element = el(`<div class="nm-mk"><div class="nm-mk-country">${label}</div></div>`);
        live.countryMarkers.push(new maplibregl.Marker({ element, anchor: "center" }).setLngLat([lng, lat]).addTo(map));
      }
    }
  };

  const updateCountryLabels = () => {
    const map = live.map;
    if (!map) return;
    const show = !NETWORK_MAP_BASE_LAYERS[live.props.baseLayer].amap;
    const zoom = map.getZoom();
    for (const marker of live.countryMarkers) {
      const element = marker.getElement();
      element.style.display = show ? "" : "none";
      (element.firstElementChild as HTMLElement).style.opacity = zoom < 5 ? "" : "0";
    }
  };

  // ---- 布局：簇 / 错开，再把线和胶囊挂上去 ----
  const relayout = () => {
    const map = live.map;
    if (!map || !live.loaded || !map.getSource(NETWORK_MAP_SOURCES.links)) return;
    const { model, showFlows } = live.props;
    const zoom = map.getZoom();
    live.layout = computeMapLayout(layoutPoints(), (lngLat) => map.project(lngLat as [number, number]), zoom);
    const layout = live.layout;
    updateCountryLabels();
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
      const flags: string[] = [];
      const healths: NetworkHealth[] = [];
      for (const key of group.keys) {
        if (key.startsWith("h")) {
          const node = nodeById.get(Number(key.slice(1)));
          if (!node) continue;
          members.push({ kind: "host", id: node.id });
          if (!cities.includes(node.city)) cities.push(node.city);
          if (node.emoji && !flags.includes(node.emoji)) flags.push(node.emoji);
          healths.push(node.health);
        } else {
          const target = targetByKey.get(key.slice(2)) as NetworkMapTarget | undefined;
          if (!target) continue;
          members.push({ kind: "target", key: target.key });
          if (target.emoji && !flags.includes(target.emoji)) flags.push(target.emoji);
          healths.push(target.health);
        }
      }
      const label = cities.slice(0, 3).join(" · ") || "落地目标";
      const element = el(`<div class="nm-mk nm-mk-cluster ${healthClass(worstHealth(healths))}"><button type="button" class="nm-mk-pill" aria-label="${escapeHtml(label)}，${group.keys.length} 个，点击放大"><span>${flags.slice(0, 3).map((flag) => (isCountryCodeLabel(flag) ? `<i class="nm-mk-code">${escapeHtml(flag)}</i>` : escapeHtml(flag))).join("")}</span><b>${group.keys.length}</b></button><div class="nm-mk-name">${escapeHtml(label)}</div></div>`);
      const center = group.center;
      (element.firstElementChild as HTMLElement).addEventListener("click", (event) => {
        event.stopPropagation();
        // 簇心已经是显示坐标（高德下转过 GCJ-02 的），直接飞，不走 api.flyTo 再转一次
        const target = live.map;
        if (!target) return;
        const zoom = Math.max(6.3, target.getZoom() + 2.2);
        if (live.props.reduceMotion) target.jumpTo({ center: center as [number, number], zoom });
        else target.flyTo({ center: center as [number, number], zoom, speed: 0.9, curve: 1.42, maxDuration: 1800, essential: true });
        live.props.onSelectCluster(center, zoom);
      });
      const marker = new maplibregl.Marker({ element, anchor: "center" }).setLngLat(center as [number, number]).addTo(map);
      live.clusterMarkers.push({ marker, members });
    }

    // 线：每一跳一条大圆弧；两端在同一个簇里就不画（簇 pill 已经说明它们在一起）
    const linkFeatures: any[] = [];
    const caps: Array<{ tunnelId: number; at: LngLat; health: NetworkHealth; text: string }> = [];
    live.linkFeatureIds = [];
    for (const link of model.links) {
      const capIndex = Math.floor((link.path.length - 2) / 2);
      for (let index = 0; index < link.path.length - 1; index += 1) {
        const keyA = `h${link.path[index]}`;
        const keyB = `h${link.path[index + 1]}`;
        const posA = layout.pos[keyA];
        const posB = layout.pos[keyB];
        if (!posA || !posB) continue;
        if (posA.clusterId !== null && posA.clusterId === posB.clusterId) continue;
        const a = displayLngLat(keyA);
        const b = displayLngLat(keyB);
        if (!a || !b) continue;
        const points = greatCircleArc(a, b);
        const fid = `t:${link.id}:${index}`;
        live.linkFeatureIds.push({ fid, tunnelId: link.id });
        linkFeatures.push({ type: "Feature", properties: { fid, tunnel: link.id, health: lineHealth(link.health) }, geometry: { type: "LineString", coordinates: points } });
        // 两端在屏幕上挨得太近（缩到全球时的港日新）胶囊会盖住 marker，线短到放不下就不挂
        const pa = map.project(a as [number, number]);
        const pb = map.project(b as [number, number]);
        if (index === capIndex && Math.hypot(pa.x - pb.x, pa.y - pb.y) >= CAP_MIN_ARC_PX) {
          const text = typeof link.latencyMs === "number" ? `${Math.round(link.latencyMs)} ms` : lineHealth(link.health) === "down" ? "中断" : lineHealth(link.health) === "standby" ? describeNetworkHealth(link.health).label : "";
          if (text) caps.push({ tunnelId: link.id, at: points[Math.floor(points.length / 2)], health: link.health, text });
        }
      }
    }
    // 看不到一端的隧道：从看得见的那一端伸出一小截灰线
    const seenStubs = new Set<number>();
    for (const stub of model.stubs) {
      const key = `h${stub.hostId}`;
      const position = layout.pos[key];
      if (!position || position.clusterId !== null) continue;
      const from = displayLngLat(key);
      if (!from) continue;
      const point = map.project(from as [number, number]);
      const end = map.unproject([point.x + 58, point.y - 44]);
      const to: LngLat = [end.lng, end.lat];
      const fid = `s:${stub.tunnelId}`;
      live.linkFeatureIds.push({ fid, tunnelId: stub.tunnelId });
      linkFeatures.push({ type: "Feature", properties: { fid, tunnel: stub.tunnelId, health: "standby" }, geometry: { type: "LineString", coordinates: [from, to] } });
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

    // 落地流向：出口 → 目标的细虚线
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
          flowFeatures.push({ type: "Feature", properties: { fid, health: lineHealth(target.health) }, geometry: { type: "LineString", coordinates: greatCircleArc(a, b) } });
        }
      }
    }
    (map.getSource(NETWORK_MAP_SOURCES.flows) as GeoJSONSource).setData({ type: "FeatureCollection", features: flowFeatures });

    // 延迟胶囊：按隧道复用
    const seenCaps = new Set<number>();
    for (const cap of caps) {
      seenCaps.add(cap.tunnelId);
      let entry = live.capMarkers.get(cap.tunnelId);
      if (!entry) {
        // marker 元素本身会被 MapLibre 写 transform 定位，所以胶囊按钮套在一个 0×0 的壳里，
        // 自己再用 translate(-50%, -50%) 居中；直接把按钮当 marker 元素，它的居中会被盖掉
        const element = el(`<div class="nm-mk"><button type="button" class="nm-mk-cap"></button></div>`);
        const button = element.firstElementChild as HTMLButtonElement;
        button.addEventListener("click", (event) => { event.stopPropagation(); live.props.onSelectLink(cap.tunnelId); });
        const marker = new maplibregl.Marker({ element, anchor: "center" }).setLngLat(cap.at as [number, number]).addTo(map);
        entry = { marker, element, button };
        live.capMarkers.set(cap.tunnelId, entry);
      } else entry.marker.setLngLat(cap.at as [number, number]);
      entry.button.className = `nm-mk-cap ${healthClass(cap.health)}`;
      entry.button.textContent = cap.text;
      const link = model.links.find((item) => item.id === cap.tunnelId);
      entry.button.setAttribute("aria-label", `${link?.name || "隧道"} ${cap.text}，查看链路`);
    }
    for (const [tunnelId, entry] of live.capMarkers) {
      if (seenCaps.has(tunnelId)) continue;
      entry.marker.remove();
      live.capMarkers.delete(tunnelId);
    }
    applyFocus();
  };

  const scheduleRelayout = () => {
    if (live.relayoutFrame) return;
    live.relayoutFrame = requestAnimationFrame(() => { live.relayoutFrame = 0; relayout(); });
  };

  // ---- 聚焦：线用 feature-state，marker 用 class ----
  const applyFocus = () => {
    const map = live.map;
    if (!map || !live.loaded || !map.getSource(NETWORK_MAP_SOURCES.links)) return;
    const { focus } = live.props;
    for (const feature of live.linkFeatureIds) map.setFeatureState({ source: NETWORK_MAP_SOURCES.links, id: feature.fid }, { dim: isTunnelDimmed(focus, feature.tunnelId) });
    for (const feature of live.flowFeatureIds) map.setFeatureState({ source: NETWORK_MAP_SOURCES.flows, id: feature.fid }, { dim: isFlowDimmed(focus, feature.targetKey, feature.ruleIds) });
    for (const [id, entry] of live.hostMarkers) entry.element.classList.toggle("is-dim", isHostDimmed(focus, id));
    for (const [key, entry] of live.targetMarkers) entry.element.classList.toggle("is-dim", isTargetDimmed(focus, key));
    for (const [tunnelId, entry] of live.capMarkers) entry.element.classList.toggle("is-dim", isTunnelDimmed(focus, tunnelId));
    for (const [tunnelId, marker] of live.stubMarkers) marker.getElement().classList.toggle("is-dim", isTunnelDimmed(focus, tunnelId));
    for (const cluster of live.clusterMarkers) cluster.marker.getElement().classList.toggle("is-dim", isClusterDimmed(focus, cluster.members));
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
      const points = layoutPoints().map((point) => point.lngLat);
      if (points.length === 0) { map.jumpTo({ center: [110, 25], zoom: 1.6 }); return; }
      const bounds = boundsForPoints(points);
      if (bounds) map.fitBounds(bounds, { maxZoom: 5, padding: FIT_PADDING, duration: live.props.reduceMotion ? 0 : 1200, essential: true });
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

  // ---- 流动光点：只改 dasharray，交给 GPU；页面不可见 / 减少动态时停 ----
  const tickDash = (timestamp: number) => {
    const map = live.map;
    if (map && live.loaded && !live.props.paused && !live.props.reduceMotion && document.visibilityState === "visible" && map.getLayer(NETWORK_MAP_LAYERS.linkFlow)) {
      if (timestamp - live.dashLast > NETWORK_MAP_DASH_INTERVAL_MS) {
        live.dashLast = timestamp;
        live.dashStep = (live.dashStep + 1) % NETWORK_MAP_DASH_STEPS.length;
        map.setPaintProperty(NETWORK_MAP_LAYERS.linkFlow, "line-dasharray", NETWORK_MAP_DASH_STEPS[live.dashStep]);
      }
    }
    live.dashFrame = requestAnimationFrame(tickDash);
  };

  // ---- 底图：改颜色和可见性；高德瓦片拉不下来时页面会切到暗黑网格，这里把瓦片层关掉，不再白请求 ----
  const applyBaseLayer = (baseLayer: NetworkMapBaseLayerId) => {
    const map = live.map;
    if (!map || !live.loaded) return;
    const patch = baseLayerPaintPatch(baseLayer);
    map.setPaintProperty(NETWORK_MAP_LAYERS.background, "background-color", patch.background);
    map.setPaintProperty(NETWORK_MAP_LAYERS.land, "fill-color", patch.land);
    map.setPaintProperty(NETWORK_MAP_LAYERS.land, "fill-opacity", patch.landOpacity);
    map.setPaintProperty(NETWORK_MAP_LAYERS.borders, "line-color", patch.border);
    map.setPaintProperty(NETWORK_MAP_LAYERS.borders, "line-width", patch.borderWidth);
    map.setLayoutProperty(NETWORK_MAP_LAYERS.graticule, "visibility", patch.graticule);
    for (const [id, visibility] of Object.entries(patch.raster)) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visibility);
  };

  // ---- 创建地图（只一次）----
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    live.colors = readColors(container.parentElement);
    const rasterIds = new Set(rasterSourceIds());
    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container,
        style: buildNetworkMapStyle(live.props.baseLayer, COUNTRIES_URL, live.colors) as any,
        center: [110, 25],
        zoom: 1.6,
        minZoom: 0.5,
        maxZoom: 14,
        attributionControl: false,
        renderWorldCopies: true,
        pitchWithRotate: false,
        dragRotate: false,
        touchPitch: false,
        fadeDuration: 0,
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
      if (live.props.reduceMotion) map.setLayoutProperty(NETWORK_MAP_LAYERS.linkFlow, "visibility", "none");
      syncStaticMarkers();
      relayout();
      if (!live.didInitialFit && layoutPoints().length > 0) { live.didInitialFit = true; api.fitAll(); }
      map.on("zoom", scheduleRelayout);
      // 动画最后一帧的 zoom 事件可能撞上数据源还在重算，zoomend 再算一次兜底
      map.on("zoomend", relayout);
      map.on("click", () => live.props.onMapClick());
      live.dashFrame = requestAnimationFrame(tickDash);
      live.props.onReady(api);
    });
    map.on("error", (event: any) => {
      // 高德瓦片拉不下来：只报一次，页面会切到暗黑网格并提示
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
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { map.resize(); scheduleRelayout(); }) : null;
    observer?.observe(container);
    return () => {
      observer?.disconnect();
      if (live.relayoutFrame) cancelAnimationFrame(live.relayoutFrame);
      if (live.dashFrame) cancelAnimationFrame(live.dashFrame);
      live.loaded = false;
      live.map = null;
      live.hostMarkers.clear();
      live.targetMarkers.clear();
      live.capMarkers.clear();
      live.stubMarkers.clear();
      live.clusterMarkers = [];
      live.countryMarkers = [];
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 模型 / 流向开关变了：同步 marker，重新布线 ----
  useEffect(() => {
    if (!live.loaded) return;
    syncStaticMarkers();
    relayout();
    if (!live.didInitialFit && layoutPoints().length > 0) { live.didInitialFit = true; api.fitAll(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.model, props.showFlows]);

  // ---- 底图变了：改颜色和可见性，坐标按新底图重算 ----
  useEffect(() => {
    const map = live.map;
    if (!map || !live.loaded) return;
    // 用户又选回高德：再拉一次瓦片，拉不下来还是要报（切走时源没人用，MapLibre 会把失败的瓦片扔掉，切回来会重新请求）
    live.rasterErrorReported = false;
    applyBaseLayer(props.baseLayer);
    // 皮肤跟着底图换了，线的颜色也要从新皮肤的变量里再读一遍
    requestAnimationFrame(() => {
      if (!live.map) return;
      live.colors = readColors(containerRef.current?.parentElement ?? null);
      const expression = healthColorExpression(live.colors);
      for (const layer of [NETWORK_MAP_LAYERS.flow, NETWORK_MAP_LAYERS.linkHalo, NETWORK_MAP_LAYERS.linkDashed, NETWORK_MAP_LAYERS.linkSolid]) {
        live.map.setPaintProperty(layer, "line-color", expression);
      }
    });
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

  useEffect(() => { applyFocus(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [props.focus]);

  useEffect(() => {
    live.map?.setPadding(props.padding);
  }, [props.padding]);

  useEffect(() => {
    const map = live.map;
    if (!map || !live.loaded || !map.getLayer(NETWORK_MAP_LAYERS.linkFlow)) return;
    // 减少动态效果：流动光点这一层直接不显示，静止的白虚线压在实线上反而像坏了
    map.setLayoutProperty(NETWORK_MAP_LAYERS.linkFlow, "visibility", props.reduceMotion ? "none" : "visible");
  }, [props.reduceMotion]);

  return <div ref={containerRef} className="nm-map" aria-label="网络地图：主机、隧道与落地目标" />;
}
