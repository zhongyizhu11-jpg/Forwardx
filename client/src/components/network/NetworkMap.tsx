import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { describeNetworkHealth, type NetworkHealth } from "@shared/networkHealth";

/**
 * 网络地图：主机是带状态环的点，线路是点与点之间的线。
 *
 * 这是「线路」方向的门面（2026-09-26 版式提案里选定的那一个）：ForwardX 管的是机器之间
 * 的连接，首页第一眼就该看到这张关系图，而不是四张写着数字的卡。
 *
 * 画法：
 *   节点   一个 13px 的圆环 + 中心一颗小点，环的颜色就是这台机器的状态（绿在线 / 红离线 /
 *          灰未接入），下面两行字：名字、一句状态（「46 ms」「离线 30 分钟」）。
 *   线     正常是一条天蓝渐变的实线，上面有几颗慢慢流动的小点（流量在跑）；降级是琥珀虚线；
 *          中断是红虚线；停用是灰虚线。多跳线路一段一段画，每段都弯一点，不和别的线叠成一根。
 *   布局   有经纬度的机器按经纬度落位（等距投影到画布里），没有的排成一个椭圆。之后再互相
 *          推开几轮，免得两台同城的机器叠在一起。
 *
 * 它不是 deck.gl 那张地球 —— 那张是给「看某台机器在哪」用的，这张是给「谁连着谁、哪条断了」
 * 用的：不画海岸线、不画国界，只画节点和线。也因此它只是一个 SVG，没有 WebGL、不吃电。
 */

export type NetworkMapNode = {
  id: number;
  name: string;
  health: NetworkHealth;
  /** 名字下面那一行（「46 ms」「离线 30 分钟」）。不传就按状态写 */
  note?: string | null;
  /** 有的话按它落位 */
  geo?: { lat: number; lng: number } | null;
};

export type NetworkMapLink = {
  id: number;
  name: string;
  /** 依次经过的节点 id：入口、中继…、出口。少于两个的不画 */
  path: number[];
  health: NetworkHealth;
  latencyMs?: number | null;
};

type Placed = NetworkMapNode & { x: number; y: number };

const NODE_RADIUS = 13;
const LABEL_LINES = 2;
const PAD_X = 48;
const PAD_TOP = 26;
const PAD_BOTTOM = 26 + LABEL_LINES * 13;

function healthColor(health: NetworkHealth) {
  return `var(--fx-${describeNetworkHealth(health).token})`;
}

/**
 * 把节点放进 width × height 的画布里。
 *
 * 全部有坐标 → 按经纬度线性投影到去掉边距的矩形里（纬度是南北向，y 轴反过来）。
 * 否则 → 一个椭圆，从正上方开始逆时针放；三个以内改成一条微弯的弧，免得三个点撑成一个三角。
 * 然后推开：任意两点近于 minGap 时沿连线方向各退一半，跑 40 轮；最后夹回画布里。
 */
export function layoutNetworkMap(nodes: readonly NetworkMapNode[], width: number, height: number): Placed[] {
  if (nodes.length === 0) return [];
  const innerW = Math.max(1, width - PAD_X * 2);
  const innerH = Math.max(1, height - PAD_TOP - PAD_BOTTOM);
  const allGeo = nodes.every((node) => node.geo);
  let placed: Placed[];
  if (allGeo && nodes.length > 1) {
    /*
      经纬度一半、名次一半。纯按经纬度画，三台亚洲机器会挤在右上角一个指甲盖大的地方，
      而美国那台独占左边半张图；按东西、南北的名次各摊开一半之后，亚洲三台之间有了距离，
      美国那台仍然在最左边 —— 看得出「谁在谁的西边」就够了，这不是一张地图。
    */
    const lats = nodes.map((node) => node.geo!.lat);
    const lngs = nodes.map((node) => node.geo!.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const latSpan = Math.max(maxLat - minLat, 4);
    const lngSpan = Math.max(maxLng - minLng, 6);
    const latMid = (minLat + maxLat) / 2;
    const lngMid = (minLng + maxLng) / 2;
    const lngOrder = [...lngs].sort((a, b) => a - b);
    const latOrder = [...lats].sort((a, b) => b - a);
    const last = Math.max(1, nodes.length - 1);
    placed = nodes.map((node) => {
      const tx = (node.geo!.lng - (lngMid - lngSpan / 2)) / lngSpan;
      const ty = (latMid + latSpan / 2 - node.geo!.lat) / latSpan;
      const rx = lngOrder.indexOf(node.geo!.lng) / last;
      const ry = latOrder.indexOf(node.geo!.lat) / last;
      return {
        ...node,
        x: PAD_X + ((tx + rx) / 2) * innerW,
        y: PAD_TOP + ((ty + ry) / 2) * innerH,
      };
    });
  } else if (nodes.length <= 3) {
    placed = nodes.map((node, index) => {
      const t = nodes.length === 1 ? 0.5 : index / (nodes.length - 1);
      return { ...node, x: PAD_X + t * innerW, y: PAD_TOP + innerH * (0.5 - 0.22 * Math.sin(t * Math.PI)) };
    });
  } else {
    const cx = width / 2, cy = PAD_TOP + innerH / 2;
    const rx = innerW / 2, ry = innerH / 2;
    placed = nodes.map((node, index) => {
      const angle = -Math.PI / 2 + (index / nodes.length) * Math.PI * 2;
      return { ...node, x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) };
    });
  }
  /*
    推开：一个节点连标签大约 84 宽、52 高。两个节点的中心在横向差不到 84 且纵向差不到 52
    时就是叠着的 —— 按差得少的那个方向推开（同城的机器经纬度几乎相同，直接推成上下两个）。
  */
  const gapX = Math.min(88, Math.max(64, innerW / Math.max(2, nodes.length) * 1.1));
  const gapY = 60;
  for (let round = 0; round < 60; round += 1) {
    let moved = false;
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i], b = placed[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const overlapX = gapX - Math.abs(dx);
        const overlapY = gapY - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        if (overlapY / gapY <= overlapX / gapX) {
          const sign = dy >= 0 ? 1 : -1;
          a.y -= (overlapY / 2) * sign; b.y += (overlapY / 2) * sign;
        } else {
          const sign = dx >= 0 ? 1 : -1;
          a.x -= (overlapX / 2) * sign; b.x += (overlapX / 2) * sign;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
  return placed.map((node) => ({
    ...node,
    x: Math.min(width - PAD_X, Math.max(PAD_X, node.x)),
    y: Math.min(height - PAD_BOTTOM, Math.max(PAD_TOP, node.y)),
  }));
}

/** 两点之间弯一点的线。同一对点之间第 k 条线往另一边弯，不叠成一根。 */
function curve(a: Placed, b: Placed, bend: number) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const k = Math.min(40, len * 0.18) * bend;
  return `M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${(mx + nx * k).toFixed(1)} ${(my + ny * k).toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

function truncateLabel(text: string, max = 14) {
  const value = String(text || "").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function useMeasuredWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(Math.max(240, Math.round(element.getBoundingClientRect().width)) || fallback);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [fallback]);
  return { ref, width };
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

export function NetworkMap({
  nodes,
  links,
  onSelectNode,
  onSelectLink,
  className,
}: {
  nodes: readonly NetworkMapNode[];
  links: readonly NetworkMapLink[];
  onSelectNode?: (node: NetworkMapNode) => void;
  onSelectLink?: (link: NetworkMapLink) => void;
  className?: string;
}) {
  const { ref, width } = useMeasuredWidth<HTMLDivElement>(360);
  const reducedMotion = usePrefersReducedMotion();
  // 手机上 360 宽画 220 高；桌面拉宽之后按比例长高一点，但封顶 300，别成一张海报。
  const height = Math.round(Math.min(300, Math.max(210, width * 0.5)));
  const placed = useMemo(() => layoutNetworkMap(nodes, width, height), [nodes, width, height]);
  const byId = useMemo(() => new Map(placed.map((node) => [node.id, node])), [placed]);

  const segments = useMemo(() => {
    const pairCount = new Map<string, number>();
    const out: { key: string; d: string; link: NetworkMapLink; token: string; dashed: boolean }[] = [];
    for (const link of links) {
      const stops = link.path.map((id) => byId.get(id)).filter((node): node is Placed => !!node);
      if (stops.length < 2) continue;
      const descriptor = describeNetworkHealth(link.health);
      for (let i = 0; i < stops.length - 1; i += 1) {
        const a = stops[i], b = stops[i + 1];
        const pairKey = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
        const seen = pairCount.get(pairKey) || 0;
        pairCount.set(pairKey, seen + 1);
        const bend = (seen % 2 === 0 ? 1 : -1) * (1 + Math.floor(seen / 2) * 0.8);
        out.push({
          key: `${link.id}:${i}`,
          d: curve(a, b, a.id < b.id ? bend : -bend),
          link,
          token: descriptor.token,
          dashed: descriptor.lineStyle !== "solid",
        });
      }
    }
    return out;
  }, [links, byId]);

  const flowing = reducedMotion ? [] : segments.filter((segment) => segment.token === "healthy").slice(0, 12);

  return (
    <div ref={ref} className={cn("fx-netmap relative w-full", className)}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="block h-auto w-full"
        role="img"
        aria-label={`网络地图：${nodes.length} 台主机，${links.length} 条线路`}
      >
        <defs>
          <pattern id="fx-netmap-dots" width="14" height="14" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" fill="var(--fx-stroke-base)" />
          </pattern>
          <linearGradient id="fx-netmap-wire" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="var(--fx-accent-strong)" stopOpacity="0.75" />
            <stop offset="1" stopColor="var(--fx-accent)" />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width={width} height={height} fill="url(#fx-netmap-dots)" />

        <g className="fx-netmap-wires">
          {segments.map((segment) => (
            <path
              key={segment.key}
              d={segment.d}
              fill="none"
              stroke={segment.token === "healthy" ? "url(#fx-netmap-wire)" : `var(--fx-${segment.token})`}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeDasharray={segment.dashed ? "6 5" : undefined}
              className={onSelectLink ? "cursor-pointer" : undefined}
              onClick={onSelectLink ? () => onSelectLink(segment.link) : undefined}
            >
              {/* <title> 只能有一个字符串子节点，先拼好再放进去 */}
              <title>{`${segment.link.name}${typeof segment.link.latencyMs === "number" ? ` · ${Math.round(segment.link.latencyMs)} ms` : ""}`}</title>
            </path>
          ))}
          {/* 透明的粗一点的一层，让 2.5px 的线也点得中 */}
          {onSelectLink ? segments.map((segment) => (
            <path key={`hit:${segment.key}`} d={segment.d} fill="none" stroke="transparent" strokeWidth={14} className="cursor-pointer" onClick={() => onSelectLink(segment.link)} />
          )) : null}
        </g>

        <g className="fx-netmap-flow" aria-hidden="true">
          {flowing.map((segment, index) => (
            <circle key={`flow:${segment.key}`} r={3} fill="var(--fx-l1-surface)" stroke="var(--fx-accent)" strokeWidth={2}>
              <animateMotion dur={`${3.2 + (index % 3) * 0.6}s`} repeatCount="indefinite" path={segment.d} begin={`${-(index * 0.7)}s`} />
            </circle>
          ))}
        </g>

        <g className="fx-netmap-nodes">
          {placed.map((node) => {
            const color = healthColor(node.health);
            const note = node.note ?? describeNetworkHealth(node.health).label;
            return (
              <g
                key={node.id}
                transform={`translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`}
                className={onSelectNode ? "cursor-pointer" : undefined}
                onClick={onSelectNode ? () => onSelectNode(node) : undefined}
                role={onSelectNode ? "button" : undefined}
                tabIndex={onSelectNode ? 0 : undefined}
                onKeyDown={onSelectNode ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectNode(node); } } : undefined}
              >
                <title>{`${node.name}${note ? ` · ${note}` : ""}`}</title>
                <circle r={NODE_RADIUS} fill="var(--fx-l1-surface)" stroke={color} strokeWidth={3} />
                <circle r={4} fill={color} />
                <text y={NODE_RADIUS + 15} textAnchor="middle" className="fx-netmap-label">{truncateLabel(node.name)}</text>
                {note ? <text y={NODE_RADIUS + 28} textAnchor="middle" className="fx-netmap-note">{truncateLabel(note, 18)}</text> : null}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
