import { useEffect, useRef, useState, type ReactNode } from "react";

import { LINE_KIND_LABELS } from "@/features/network/networkMapLines";
import type { NetworkMapModel, NetworkMapTunnelLink } from "@/features/network/networkMapModel";
import { formatBitrate, formatDelta, type LatencyStats, type RateWindow } from "@/features/network/networkMapSeries";
import { describeNetworkHealth } from "@shared/networkHealth";

import { drawLineChart, readCssColor } from "./mapCharts";
import { HostRow, LinkDetailView, Pill, Section, tone, useCanvasChart, type LinkDetailViewProps } from "./NetworkMapSheetViews";

/**
 * 选中一条隧道时的详情面板（桌面是图右边浮着的玻璃卡，手机是底部抽屉）：
 * 五个标签 —— 总览、节点、链路、流量、策略。
 *
 *   总览  基本信息、网络路径（一跳一行的竖向步骤条，最后一行是落地）、实时数据（最近 1 小时 / 24 小时的
 *         下行 / 上行速率、延迟、探测成功率，和前一段比），底下一个「查看详情」去链路管理
 *   节点  路径上的每台主机，点了看主机
 *   链路  延迟走势、探测成功率、逐跳、走这条隧道的规则、诊断（原来抽屉里的那些）
 *   流量  近 24 小时 / 累计的下行上行
 *   策略  挂在这条隧道上的规则的线路组（主备）设置，只读
 *
 * 全是「拿数据画出来」：数据由页面取好传进来，这里不发请求 —— 能在 node 里 renderToStaticMarkup 测。
 * 没有的数一律写「—」，不编。
 */

export type LinkPanelTab = "overview" | "nodes" | "links" | "traffic" | "policy";
export const LINK_PANEL_TABS: Array<{ id: LinkPanelTab; label: string }> = [
  { id: "overview", label: "总览" },
  { id: "nodes", label: "节点" },
  { id: "links", label: "链路" },
  { id: "traffic", label: "流量" },
  { id: "policy", label: "策略" },
];

export type LiveRange = "1h" | "24h";
export const LIVE_RANGE_LABELS: Record<LiveRange, string> = { "1h": "最近 1 小时", "24h": "最近 24 小时" };

export type LinkLiveData = {
  down: RateWindow | null;
  up: RateWindow | null;
  latency: LatencyStats | null;
  latencyDelta: number | null;
  loading: boolean;
};

export type LinkPanelProps = {
  model: NetworkMapModel;
  link: NetworkMapTunnelLink;
  tab: LinkPanelTab;
  onTab: (tab: LinkPanelTab) => void;
  range: LiveRange;
  onRange: (range: LiveRange) => void;
  live: LinkLiveData;
  /** 链路 / 流量两个标签用的（原来抽屉里那份） */
  detail: Omit<LinkDetailViewProps, "model" | "link" | "sections">;
  onOpenNode: (hostId: number) => void;
  /** 「查看地图」：把相机框到这条路径上 */
  onFocusPath: () => void;
  /** 「查看详情」：去链路管理 / 转发规则 */
  onViewDetail: () => void;
  viewDetailLabel: string;
};

/** 「2026-10-01 11:20」：本地时间，到分钟 */
export function formatDateTime(ms: number | null): string {
  if (!ms || !Number.isFinite(ms)) return "—";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 面板头上的状态：正常写「健康」，别的照状态词汇表 */
export function linkStatusLabel(link: Pick<NetworkMapTunnelLink, "health">): string {
  return link.health === "healthy" ? "健康" : describeNetworkHealth(link.health).label;
}

/** 这条隧道上开了线路组的规则里，最近一次切换的时刻（Agent 报上来的）；没有就是 null */
export function lastSwitchAt(model: Pick<NetworkMapModel, "rules">, tunnelId: number): number | null {
  let latest: number | null = null;
  for (const rule of model.rules) {
    if (rule.tunnelId !== tunnelId || !rule.routeGroup?.activeSince) continue;
    if (latest === null || rule.routeGroup.activeSince > latest) latest = rule.routeGroup.activeSince;
  }
  return latest;
}

/** 落地：走这条隧道的规则的目标（去重） */
export function linkLandings(model: Pick<NetworkMapModel, "rules">, tunnelId: number): string[] {
  const out: string[] = [];
  for (const rule of model.rules) {
    if (rule.tunnelId !== tunnelId || !rule.targetIp) continue;
    const text = `${rule.targetIp}:${rule.targetPort}`;
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

function GlobeIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" /></svg>;
}

export function LinkPanelTabs({ tab, onTab }: { tab: LinkPanelTab; onTab: (tab: LinkPanelTab) => void }) {
  return (
    <div className="nm-tabs" role="tablist" aria-label="详情">
      {LINK_PANEL_TABS.map((item) => (
        <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={`nm-tab${tab === item.id ? " is-active" : ""}`} onClick={() => onTab(item.id)}>{item.label}</button>
      ))}
    </div>
  );
}

export function LinkPanelBody(props: LinkPanelProps) {
  const { model, link, tab } = props;
  if (tab === "nodes") return <NodesTab model={model} link={link} onOpenNode={props.onOpenNode} />;
  if (tab === "links") return <LinkDetailView model={model} link={link} {...props.detail} sections={["head", "quality", "hops", "rules", "actions"]} />;
  if (tab === "traffic") return <TrafficTab {...props} />;
  if (tab === "policy") return <PolicyTab model={model} link={link} />;
  return <OverviewTab {...props} />;
}

function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return <div className="nm-kv"><dt>{label}</dt><dd>{children}</dd></div>;
}

function OverviewTab({ model, link, range, onRange, live, onFocusPath, onViewDetail, viewDetailLabel }: LinkPanelProps) {
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const landings = linkLandings(model, link.id);
  const switchedAt = lastSwitchAt(model, link.id);
  const lineType = link.kind === "backup" ? LINE_KIND_LABELS.backup : LINE_KIND_LABELS.main;
  return (
    <>
      <Section title="基本信息">
        <dl className="nm-kvs">
          <KeyValue label="名称">{link.name}</KeyValue>
          <KeyValue label="状态"><Pill tone={tone(link.health)}>{linkStatusLabel(link)}</Pill></KeyValue>
          <KeyValue label="线路类型"><span className={`nm-accent-text${link.kind === "backup" ? " is-muted" : ""}`}>{lineType}</span> <span className="nm-dim-text">· {link.modeLabel}</span></KeyValue>
          <KeyValue label="落地节点"><span className="nm-num">{landings[0] ?? "—"}</span>{landings.length > 1 ? <span className="nm-dim-text"> 等 {landings.length} 个</span> : null}</KeyValue>
          <KeyValue label="最近切换">{formatDateTime(switchedAt)}</KeyValue>
          <KeyValue label="创建时间">{formatDateTime(link.createdAt)}</KeyValue>
        </dl>
      </Section>
      <section className="nm-section">
        <h3 className="nm-section-title"><span>网络路径</span><button type="button" className="nm-link-btn" onClick={onFocusPath}>查看地图</button></h3>
        <ol className={`nm-steps is-${link.kind}`}>
          {link.path.map((hostId, index) => {
            const node = nodeById.get(hostId);
            const hop = index > 0 ? link.hopLatencies[index - 1] ?? null : null;
            const role = index === 0 ? "入口" : index === link.path.length - 1 ? "出口" : "中继";
            return (
              <li key={`${hostId}-${index}`} className={`nm-step${node ? ` is-${tone(node.health)}` : ""}`}>
                <span className="nm-step-dot" aria-hidden="true" />
                <span className="nm-step-flag" aria-hidden="true">{node?.emoji || "·"}</span>
                <span className="nm-step-main">
                  <b>{node?.city || "看不到的主机"}<small>{node && node.city !== node.name ? node.name : ""}</small></b>
                  <span className="nm-num">{index === 0 ? "起点" : typeof hop === "number" ? `${Math.round(hop)} ms` : "—"}</span>
                </span>
                <span className={`nm-role is-${index === 0 ? "entry" : index === link.path.length - 1 ? "exit" : "relay"}`}>{role}</span>
              </li>
            );
          })}
          {landings.slice(0, 2).map((address) => (
            <li key={address} className="nm-step is-landing">
              <span className="nm-step-dot" aria-hidden="true" />
              <span className="nm-step-flag is-globe"><GlobeIcon /></span>
              <span className="nm-step-main"><b className="nm-num">{address}</b><span>落地目标</span></span>
              <span className="nm-role is-landing">落地</span>
            </li>
          ))}
        </ol>
      </section>
      <section className="nm-section">
        <h3 className="nm-section-title">
          <span>实时数据</span>
          <select className="nm-range" value={range} onChange={(event) => onRange(event.target.value as LiveRange)} aria-label="时间范围">
            {(Object.keys(LIVE_RANGE_LABELS) as LiveRange[]).map((key) => <option key={key} value={key}>{LIVE_RANGE_LABELS[key]}</option>)}
          </select>
        </h3>
        <LiveCards live={live} />
      </section>
      <div className="nm-cta">
        <button type="button" className="nm-primary" onClick={onViewDetail}>{viewDetailLabel}</button>
      </div>
    </>
  );
}

/** 四张小卡：下行、上行、延迟、探测成功率 */
export function LiveCards({ live }: { live: LinkLiveData }) {
  const success = live.latency?.successRate ?? null;
  return (
    <div className="nm-live">
      <RateCard label="下行速率" window={live.down} color="--nm-chart-down" loading={live.loading} />
      <RateCard label="上行速率" window={live.up} color="--nm-chart-up" loading={live.loading} />
      <MiniCard
        label="延迟"
        value={live.latency?.avg !== null && live.latency?.avg !== undefined ? `${Math.round(live.latency.avg)}` : "—"}
        unit="ms"
        delta={live.latencyDelta}
        // 延迟变高是坏事：涨了标成警告色
        deltaBad={(live.latencyDelta ?? 0) > 0}
        series={live.latency?.series ?? []}
        color="--nm-chart-latency"
        loading={live.loading}
      />
      <MiniCard
        label="探测成功率"
        value={success === null ? "—" : success >= 99.95 ? "100" : success.toFixed(1)}
        unit="%"
        delta={null}
        footnote={live.latency?.probeTotal ? `${live.latency.probeTotal} 次探测` : "没有探测记录"}
        color="--nm-chart-latency"
        loading={live.loading}
      />
    </div>
  );
}

function RateCard({ label, window, color, loading }: { label: string; window: RateWindow | null; color: string; loading: boolean }) {
  const text = window?.avg !== null && window?.avg !== undefined ? formatBitrate(window.avg) : "—";
  const [value, unit] = text === "—" ? ["—", ""] : [text.split(" ")[0], text.split(" ")[1] ?? ""];
  return <MiniCard label={label} value={value} unit={unit} delta={window?.delta ?? null} series={window?.series ?? []} color={color} loading={loading} footnote="平均" />;
}

function MiniCard({ label, value, unit, delta, deltaBad, series, color, loading, footnote }: { label: string; value: string; unit: string; delta: number | null; deltaBad?: boolean; series?: ReadonlyArray<number | null>; color: string; loading: boolean; footnote?: string }) {
  const ref = useCanvasChart((canvas, palette) => {
    drawLineChart(canvas, series ?? [], { color: readCssColor(canvas, color, palette.line), palette });
  }, [series, color]);
  const deltaText = formatDelta(delta);
  return (
    <div className="nm-live-card">
      <div className="nm-live-label">{label}</div>
      <div className="nm-live-value"><b className="nm-num">{loading && value === "—" ? "…" : value}</b>{unit ? <small>{unit}</small> : null}</div>
      <div className={`nm-live-delta${deltaText ? (deltaBad ? " is-bad" : (delta ?? 0) >= 0 ? " is-up" : " is-down") : ""}`}>{deltaText ? `${deltaText} 较上一段` : footnote ?? "—"}</div>
      {series ? <canvas ref={ref} aria-hidden="true" /> : null}
    </div>
  );
}

function NodesTab({ model, link, onOpenNode }: { model: NetworkMapModel; link: NetworkMapTunnelLink; onOpenNode: (hostId: number) => void }) {
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  return (
    <Section title="路径上的主机" count={link.path.length}>
      <div className="nm-list">
        {link.path.map((hostId, index) => {
          const node = nodeById.get(hostId);
          return node ? <HostRow key={`${hostId}-${index}`} node={node} onOpen={onOpenNode} /> : <div key={`${hostId}-${index}`} className="nm-row is-static"><span className="nm-lead">·</span><span className="nm-main"><b>看不到的主机</b><span>不在你的主机范围里</span></span><span /></div>;
        })}
      </div>
    </Section>
  );
}

function TrafficTab(props: LinkPanelProps) {
  return (
    <>
      <section className="nm-section">
        <h3 className="nm-section-title">
          <span>速率</span>
          <select className="nm-range" value={props.range} onChange={(event) => props.onRange(event.target.value as LiveRange)} aria-label="时间范围">
            {(Object.keys(LIVE_RANGE_LABELS) as LiveRange[]).map((key) => <option key={key} value={key}>{LIVE_RANGE_LABELS[key]}</option>)}
          </select>
        </h3>
        <div className="nm-live">
          <RateCard label="下行速率" window={props.live.down} color="--nm-chart-down" loading={props.live.loading} />
          <RateCard label="上行速率" window={props.live.up} color="--nm-chart-up" loading={props.live.loading} />
        </div>
      </section>
      <LinkDetailView model={props.model} link={props.link} {...props.detail} sections={["traffic"]} />
    </>
  );
}

function PolicyTab({ model, link }: { model: NetworkMapModel; link: NetworkMapTunnelLink }) {
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const rules = model.rules.filter((rule) => rule.tunnelId === link.id && rule.routeGroup);
  if (rules.length === 0) {
    return (
      <Section title="切换策略">
        <div className="nm-empty">这条隧道上没有开线路组（主备）的规则。在转发规则里给规则加上备用线路，这里会显示它的切换策略。</div>
      </Section>
    );
  }
  return (
    <>
      {rules.map((rule) => {
        const group = rule.routeGroup!;
        return (
          <Section key={rule.id} title={rule.name} count={group.modeLabel}>
            <dl className="nm-kvs">
              <KeyValue label="切换方式">{group.switchLabel}</KeyValue>
              <KeyValue label="故障判定">{group.failoverSeconds} 秒</KeyValue>
              <KeyValue label="恢复判定">{group.recoverSeconds} 秒</KeyValue>
              <KeyValue label="自动回切">{group.autoFailback ? "开" : "关"}</KeyValue>
              <KeyValue label="最近切换">{formatDateTime(group.activeSince)}</KeyValue>
            </dl>
            <div className="nm-list" style={{ marginTop: 10 }}>
              {group.paths.map((path, index) => (
                <div key={path.key} className="nm-row is-static">
                  <span className="nm-lead nm-role">{String.fromCharCode(65 + index)}</span>
                  <span className="nm-main">
                    <b>{path.name}</b>
                    <span>{[...path.hops.map((id) => nodeById.get(id)?.name || `主机 #${id}`), path.dest || "落地"].join(" → ")}</span>
                  </span>
                  <span className="nm-trail">
                    {path.issue ? <Pill tone="down">不可用</Pill> : group.activeIndex === index ? <Pill tone="ok">正在走</Pill> : <Pill>{index === 0 ? "主线路" : "备用"}</Pill>}
                  </span>
                </div>
              ))}
            </div>
            {group.activeIndex === null ? <p className="nm-foot-note" style={{ marginTop: 10 }}>Agent 还没报过正在走哪条。</p> : null}
          </Section>
        );
      })}
    </>
  );
}

/** ⋮ 菜单：几样不常用的操作 */
export function PanelMenu({ items }: { items: Array<{ label: string; onClick: () => void; disabled?: boolean }> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div ref={ref} className="nm-menu-wrap">
      <button type="button" className="nm-icon-btn" aria-label="更多操作" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" /></svg>
      </button>
      {open ? (
        <div className="nm-popover" role="menu">
          {items.map((item) => <button key={item.label} type="button" role="menuitem" disabled={item.disabled} onClick={() => { setOpen(false); item.onClick(); }}>{item.label}</button>)}
        </div>
      ) : null}
    </div>
  );
}
