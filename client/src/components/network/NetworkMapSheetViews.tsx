import { useEffect, useRef, type ReactNode } from "react";

import { fxpRuntimeDetailText } from "@/components/hosts/FxpRuntimeBadge";
import type { NetworkMapAlert } from "@/features/network/networkMapAlerts";
import { NETWORK_MAP_LATENCY_WARN_MS } from "@/features/network/networkMapAlerts";
import type { NetworkMapHostNode, NetworkMapModel, NetworkMapRule, NetworkMapTarget, NetworkMapTunnelLink } from "@/features/network/networkMapModel";
import { formatBitrate, formatBytesShort, formatLatency, formatUptime, usageTone, type HostVitals, type LatencyStats } from "@/features/network/networkMapSeries";
import { formatAgo } from "@shared/dashboardAttention";
import { describeNetworkHealth, type NetworkHealth } from "@shared/networkHealth";

import { drawDualChart, drawLineChart, readCssColor, type ChartPalette } from "./mapCharts";

/**
 * 抽屉里的四个视图：总览、节点、链路、落地目标。
 *
 * 全是「拿数据画出来」的组件：数据由页面取好传进来，这里不发请求、不碰地图 ——
 * 所以能在 node 里 renderToStaticMarkup 测文案和结构。图表是 canvas，在 effect 里画，
 * 服务端渲染时不跑。
 */

type Tone = "ok" | "warn" | "down" | "standby";

function tone(health: NetworkHealth): Tone {
  const token = describeNetworkHealth(health).token;
  if (token === "healthy") return "ok";
  if (token === "warn" || token === "path") return "warn";
  if (token === "down") return "down";
  return "standby";
}

export function Pill({ tone: t, children, mono, wrap }: { tone?: Tone | "link"; children: ReactNode; mono?: boolean; wrap?: boolean }) {
  return <span className={["nm-pill", t || "", mono ? "mono" : "", wrap ? "wrap" : ""].filter(Boolean).join(" ")}>{t && t !== "link" && !wrap ? <span className="nm-dot" aria-hidden="true" /> : null}{children}</span>;
}

function Icon({ name }: { name: "back" | "go" | "copy" | "ping" | "upgrade" | "detail" | "test" }) {
  const paths: Record<string, string> = {
    back: "M15 6l-6 6 6 6",
    go: "M9 6l6 6-6 6",
    copy: "M9 9h11v11H9zM5 15V5a2 2 0 0 1 2-2h10",
    ping: "M4 12h3l3-7 4 14 3-7h3",
    upgrade: "M12 19V5M5 12l7-7 7 7",
    detail: "M4 6h16M4 12h16M4 18h10",
    test: "M9 3h6M12 3v6m-5 4 5-4 5 4-5 8-5-8z",
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function SheetHead({ onBack, title, subtitle, trailing }: { onBack?: () => void; title: ReactNode; subtitle?: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="nm-sheet-head">
      {onBack ? <button type="button" className="nm-back" aria-label="返回总览" onClick={onBack}><Icon name="back" /></button> : null}
      <div className="nm-headline"><b>{title}</b>{subtitle ? <small>{subtitle}</small> : null}</div>
      {trailing ? <div className="nm-pill-slot">{trailing}</div> : null}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: ReactNode; children: ReactNode }) {
  return (
    <section className="nm-section">
      <h3 className="nm-section-title"><span>{title}</span>{count !== undefined ? <span className="nm-count">{count}</span> : null}</h3>
      {children}
    </section>
  );
}

/** 画布：尺寸变了（抽屉拖动、切换视图）就重画 */
function useCanvasChart(draw: (canvas: HTMLCanvasElement, palette: ChartPalette) => void, deps: unknown[]) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const paint = () => {
      const palette: ChartPalette = {
        line: readCssColor(canvas, "--nm-link", "#06b6d4"),
        muted: readCssColor(canvas, "--nm-muted", "#8b9bb4"),
        grid: readCssColor(canvas, "--nm-line", "rgba(128,128,128,0.2)"),
        warn: readCssColor(canvas, "--nm-warn", "#f59e0b"),
        // 坐标轴上的字和面板正文同一种字体（以前是等宽，「24 小时前」被拉得很散）
        font: getComputedStyle(canvas).getPropertyValue("--fx-font").trim() || "system-ui, sans-serif",
      };
      draw(canvas, palette);
    };
    const frame = requestAnimationFrame(paint);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => paint()) : null;
    observer?.observe(canvas);
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

// ---------------- 总览 ----------------

export type OverviewViewProps = {
  model: NetworkMapModel;
  alerts: NetworkMapAlert[];
  onAlert: (alert: NetworkMapAlert) => void;
  onOpenNode: (hostId: number) => void;
  onOpenLink: (tunnelId: number) => void;
  baseLayerAmap: boolean;
};

export function OverviewView({ model, alerts, onAlert, onOpenNode, onOpenLink, baseLayerAmap }: OverviewViewProps) {
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const hostName = (id: number) => nodeById.get(id)?.name || "看不到的主机";
  const unlocated = model.nodes.filter((node) => !node.geo);
  const located = model.nodes.filter((node) => node.geo);
  return (
    <>
      <Section title="需要关注" count={alerts.length}>
        {alerts.length === 0 ? <div className="nm-empty">一切正常，没有要处理的</div> : (
          <div className="nm-list">
            {alerts.map((alert) => (
              <button key={alert.id} type="button" className={`nm-alert ${alert.severity}`} onClick={() => onAlert(alert)}>
                <span className="nm-stripe" aria-hidden="true" />
                <span className="nm-body"><b>{alert.title}</b><span>{alert.detail}</span></span>
                <span className="nm-go">{alert.action}<Icon name="go" /></span>
              </button>
            ))}
          </div>
        )}
      </Section>
      <Section title="隧道" count={`正常 ${model.legend.healthy}${model.legend.degraded ? ` · 降级 ${model.legend.degraded}` : ""}${model.legend.down ? ` · 中断 ${model.legend.down}` : ""}${model.legend.standby ? ` · 停用 ${model.legend.standby}` : ""}`}>
        {model.links.length === 0 && model.stubs.length === 0 ? <div className="nm-empty">还没有线路。把两台主机连起来，这里就会出现第一条线。</div> : (
          <div className="nm-list">
            {model.links.map((link) => (
              <button key={link.id} type="button" className="nm-row" onClick={() => onOpenLink(link.id)}>
                <span className="nm-lead" aria-hidden="true">{nodeById.get(link.path[0])?.emoji || "·"}</span>
                <span className="nm-main"><b>{link.name} <Pill mono>{link.modeLabel}</Pill></b><span>{link.path.map(hostName).join(" → ")}</span></span>
                <span className="nm-trail"><Pill tone={tone(link.health)}>{typeof link.latencyMs === "number" ? formatLatency(link.latencyMs) : describeNetworkHealth(link.health).label}</Pill></span>
              </button>
            ))}
            {model.stubs.map((stub) => (
              <div key={`stub-${stub.tunnelId}`} className="nm-row is-static">
                <span className="nm-lead" aria-hidden="true">{nodeById.get(stub.hostId)?.emoji || "·"}</span>
                <span className="nm-main"><b>{stub.name} <Pill mono>{stub.modeLabel}</Pill></b><span>{hostName(stub.hostId)} → 看不到的主机</span></span>
                <span className="nm-trail"><Pill tone={tone(stub.health)}>{describeNetworkHealth(stub.health).label}</Pill></span>
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section title="主机" count={model.nodes.length}>
        <div className="nm-list">
          {located.map((node) => <HostRow key={node.id} node={node} onOpen={onOpenNode} />)}
        </div>
      </Section>
      {unlocated.length > 0 ? (
        <Section title="未定位" count={unlocated.length}>
          <p className="nm-foot-note" style={{ marginTop: 0, marginBottom: 8 }}>IP 定位没给出坐标的主机，不在图上，详情照样能看。</p>
          <div className="nm-list">
            {unlocated.map((node) => <HostRow key={node.id} node={node} onOpen={onOpenNode} />)}
          </div>
        </Section>
      ) : null}
      <p className="nm-foot-note">
        {model.hiddenLinkCount > 0 ? `${model.hiddenLinkCount} 条隧道的另一端不在你的主机范围里，画成了灰色短线。` : null}
        {baseLayerAmap ? " 底图：高德地图（GCJ-02，大陆境内的点已做坐标转换）。" : " 底图：Natural Earth 国界。"}
        主机位置来自 IP 定位，精确到城市。
      </p>
    </>
  );
}

function HostRow({ node, onOpen }: { node: NetworkMapHostNode; onOpen: (hostId: number) => void }) {
  return (
    <button type="button" className="nm-row" onClick={() => onOpen(node.id)}>
      <span className="nm-lead" aria-hidden="true">{node.emoji || "·"}</span>
      <span className="nm-main"><b>{node.name}</b><span>{[node.region, node.ip ? <span key="ip" className="nm-num">{node.ip}</span> : null].filter(Boolean).map((part, index) => <span key={index}>{index > 0 ? " · " : ""}{part}</span>)}</span></span>
      <span className="nm-trail"><Pill tone={tone(node.health)}>{node.isOnline ? "在线" : node.note?.startsWith("离线") ? node.note : describeNetworkHealth(node.health).label}</Pill></span>
    </button>
  );
}

// ---------------- 节点 ----------------

export function hostRole(model: Pick<NetworkMapModel, "links" | "rules">, hostId: number): string {
  const entry = model.links.some((link) => link.path[0] === hostId) || model.rules.some((rule) => rule.hostId === hostId);
  const exit = model.links.some((link) => link.path.length > 1 && link.path[link.path.length - 1] === hostId);
  const relay = model.links.some((link) => link.path.length > 2 && link.path.slice(1, -1).includes(hostId));
  const parts = [entry ? "入口" : null, relay ? "中转" : null, exit ? "出口" : null].filter(Boolean);
  return parts.join(" · ") || "未接线";
}

export type NodeDetailViewProps = {
  model: NetworkMapModel;
  node: NetworkMapHostNode;
  vitals: HostVitals | null;
  vitalsLoading: boolean;
  memoryTotal: number | null;
  now: number;
  /** 管理员且 Agent / FXP 过旧时才有 */
  onUpgrade: (() => void) | null;
  upgrading: boolean;
  onNetworkTest: (() => void) | null;
  onHostDetail: () => void;
  onOpenLink: (tunnelId: number) => void;
  onCopy: (text: string) => void;
};

export function NodeDetailView({ model, node, vitals, vitalsLoading, memoryTotal, now, onUpgrade, upgrading, onNetworkTest, onHostDetail, onOpenLink, onCopy }: NodeDetailViewProps) {
  const linkById = new Map(model.links.map((link) => [link.id, link]));
  const rules = model.rules.filter((rule) => rule.hostId === node.id || rule.exitHostId === node.id);
  const linksThrough = model.links.filter((link) => link.path.includes(node.id));
  const memoryPercent = vitals?.memoryPercent ?? (vitals?.memoryUsed !== null && vitals?.memoryUsed !== undefined && memoryTotal ? Math.round((vitals.memoryUsed / memoryTotal) * 100) : null);
  const diskPercent = vitals?.diskPercent ?? null;
  const cpuRef = useCanvasChart((canvas, palette) => {
    drawLineChart(canvas, vitals?.cpuSeries || [], { color: readCssColor(canvas, "--nm-accent", palette.line), max: 100, palette });
  }, [vitals]);
  const netRef = useCanvasChart((canvas, palette) => {
    // 入站是地图上线路的强调色，出站是第二个分类色（青）：以前两条都是强调色，叠在一起分不出谁是谁
    drawDualChart(canvas, vitals?.netInSeries || [], vitals?.netOutSeries || [], {
      colorA: palette.line,
      colorB: readCssColor(canvas, "--nm-series-2", palette.line),
      palette,
      formatTick: (value) => formatBitrate(value),
      axisLabels: ["24 小时前", "现在"],
    });
  }, [vitals]);
  const heartbeat = node.isOnline
    ? <Pill tone="ok">心跳正常{node.lastHeartbeat ? ` · ${formatAgo(now - node.lastHeartbeat)}` : ""}</Pill>
    : <Pill tone={tone(node.health)}>{node.lastHeartbeat ? `离线 · 最后在线 ${formatAgo(now - node.lastHeartbeat)}` : "还没接入"}</Pill>;
  return (
    <>
      <div className="nm-head-card">
        <div className="nm-flag" aria-hidden="true">{node.emoji || "·"}</div>
        <div className="nm-meta">
          <div className="nm-line">
            {node.ip ? <button type="button" className="nm-copy" onClick={() => onCopy(node.ip!)} aria-label={`复制 IP ${node.ip}`}>{node.ip}<Icon name="copy" /></button> : <span>没有公网 IP</span>}
            <span>运行 <span className="nm-num">{vitalsLoading && !vitals ? "…" : formatUptime(vitals?.uptimeSeconds)}</span></span>
          </div>
          <div className="nm-line">{heartbeat}</div>
        </div>
      </div>
      <Section title="硬件负载" count="近 24 小时">
        {!vitalsLoading && vitals && vitals.sampleCount === 0 ? <div className="nm-empty">这台主机近 24 小时没有上报指标</div> : null}
        <div className="nm-metrics">
          <div className="nm-metric">
            <div className="nm-label"><span>CPU</span></div>
            <div className="nm-value">{vitals?.cpuNow ?? "—"}<small>%</small></div>
            <canvas ref={cpuRef} aria-label="CPU 24 小时走势" />
          </div>
          <div className="nm-metric">
            <div className="nm-label"><span>内存</span><span className="nm-num">{memoryPercent ?? "—"}%</span></div>
            <div className="nm-value">{formatBytesShort(vitals?.memoryUsed)}<small>/ {formatBytesShort(memoryTotal)}</small></div>
            <div className="nm-bar" role="progressbar" aria-label="内存使用率" aria-valuenow={memoryPercent ?? undefined} aria-valuemin={0} aria-valuemax={100}><i className={usageTone(memoryPercent)} style={{ width: `${Math.min(100, memoryPercent ?? 0)}%` }} /></div>
            <div className="nm-label" style={{ marginTop: 12 }}><span>磁盘</span><span className="nm-num">{diskPercent ?? "—"}%</span></div>
            <div className="nm-bar" role="progressbar" aria-label="磁盘使用率" aria-valuenow={diskPercent ?? undefined} aria-valuemin={0} aria-valuemax={100}><i className={usageTone(diskPercent, 80, 90)} style={{ width: `${Math.min(100, diskPercent ?? 0)}%` }} /></div>
            <div className="nm-foot"><span>{formatBytesShort(vitals?.diskUsed)} / {formatBytesShort(vitals?.diskTotal)}</span><span>{vitals?.diskTotal && vitals.diskUsed !== null ? `${formatBytesShort(vitals.diskTotal - vitals.diskUsed)} 可用` : ""}</span></div>
          </div>
          <div className="nm-metric wide">
            <div className="nm-label"><span>网络吞吐</span><span className="nm-num">↓ {formatBitrate(vitals?.netInNow)} · ↑ {formatBitrate(vitals?.netOutNow)}</span></div>
            <canvas ref={netRef} className="tall" aria-label="入站 / 出站速率 24 小时走势" />
            <div className="nm-legend-inline"><span><i style={{ background: "var(--nm-link)" }} />入站</span><span><i style={{ background: "var(--nm-series-2)" }} />出站</span></div>
          </div>
        </div>
      </Section>
      <Section title="转发规则" count={rules.length}>
        {rules.length === 0 ? <div className="nm-empty">这台主机上没有规则</div> : (
          <div className="nm-list">
            {rules.map((rule) => {
              const link = rule.tunnelId ? linkById.get(rule.tunnelId) : undefined;
              const role = rule.hostId === node.id ? "入口" : "出口";
              const body = (
                <>
                  <span className="nm-lead nm-role">{role}</span>
                  <span className="nm-main"><b>{rule.name} <Pill mono>{rule.protocol.toUpperCase()}</Pill></b><span className="nm-num">:{rule.sourcePort} → {rule.targetIp}:{rule.targetPort}{link ? ` · ${link.name}` : " · 直连"}</span></span>
                  <span className="nm-trail"><Pill tone={tone(rule.health)}>{rule.stopReason || (rule.running ? "运行中" : rule.enabled ? "未运行" : "已停用")}</Pill></span>
                </>
              );
              return link
                ? <button key={rule.id} type="button" className="nm-row" onClick={() => onOpenLink(link.id)}>{body}</button>
                : <div key={rule.id} className="nm-row is-static">{body}</div>;
            })}
          </div>
        )}
      </Section>
      {linksThrough.length > 0 ? (
        <Section title="经过这台主机的隧道" count={linksThrough.length}>
          <div className="nm-list">
            {linksThrough.map((link) => (
              <button key={link.id} type="button" className="nm-row" onClick={() => onOpenLink(link.id)}>
                <span className="nm-lead" aria-hidden="true">{model.nodes.find((item) => item.id === link.path[0])?.emoji || "·"}</span>
                <span className="nm-main"><b>{link.name}</b><span>{link.modeLabel} · {link.path.length - 1} 跳</span></span>
                <span className="nm-trail"><Pill tone={tone(link.health)}>{typeof link.latencyMs === "number" ? formatLatency(link.latencyMs) : describeNetworkHealth(link.health).label}</Pill></span>
              </button>
            ))}
          </div>
        </Section>
      ) : null}
      <Section title="快捷操作">
        <div className="nm-actions">
          <button type="button" className="nm-action" onClick={onNetworkTest ?? undefined} disabled={!onNetworkTest} title={onNetworkTest ? "到网络测试页从这台主机发起 Ping / MTR" : "没有网络测试权限"}><Icon name="ping" />网络测试</button>
          <button type="button" className="nm-action" onClick={onUpgrade ?? undefined} disabled={!onUpgrade || upgrading} title={onUpgrade ? "升级 Agent（会一并升级 FXP）" : "Agent 已是最新"}><Icon name="upgrade" />{upgrading ? "升级中…" : "升级 Agent"}</button>
          <button type="button" className="nm-action" onClick={onHostDetail}><Icon name="detail" />主机详情</button>
        </div>
      </Section>
    </>
  );
}

export function nodeHeadSubtitle(node: NetworkMapHostNode, model: Pick<NetworkMapModel, "links" | "rules">): string {
  const agent = node.agentVersion ? `Agent ${node.agentVersion}` : "Agent 未上报版本";
  const fxp = `FXP ${fxpRuntimeDetailText(node)}`;
  return [node.region, hostRole(model, node.id), agent, fxp].filter(Boolean).join(" · ");
}

// ---------------- 链路 ----------------

export type LinkDetailViewProps = {
  model: NetworkMapModel;
  link: NetworkMapTunnelLink;
  latency: LatencyStats | null;
  latencyLoading: boolean;
  latencyError: string | null;
  traffic: { day: { bytesIn: number; bytesOut: number } | null; total: { bytesIn: number; bytesOut: number } | null };
  onDiagnose: (() => void) | null;
  diagnosing: boolean;
  onOpenNode: (hostId: number) => void;
};

export function linkHeadTitle(link: NetworkMapTunnelLink, nodes: readonly NetworkMapHostNode[]): string {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const name = (id: number) => {
    const node = nodeById.get(id);
    if (!node) return "看不到的主机";
    return node.countryCode ? `${node.name} (${node.countryCode})` : node.name;
  };
  return `${name(link.path[0])} → ${name(link.path[link.path.length - 1])}`;
}

/** 链路的一句异常说明：FXP 过旧 > 可用性那句话 > 停用 */
export function linkIssueText(link: NetworkMapTunnelLink): string | null {
  if (link.fxpIssues.length > 0) return link.fxpIssues.join("；");
  if (!link.enabled) return "这条隧道已停用";
  if (link.health === "down" || link.health === "degraded" || link.health === "unknown") return link.availabilityMessage || null;
  return null;
}

export function LinkDetailView({ model, link, latency, latencyLoading, latencyError, traffic, onDiagnose, diagnosing, onOpenNode }: LinkDetailViewProps) {
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const rules = model.rules.filter((rule) => rule.tunnelId === link.id);
  const issue = linkIssueText(link);
  const latencyNow = link.latencyMs ?? latency?.latest ?? null;
  const latencyRef = useCanvasChart((canvas, palette) => {
    drawLineChart(canvas, latency?.series || [], {
      color: readCssColor(canvas, tone(link.health) === "ok" ? "--nm-link" : tone(link.health) === "down" ? "--nm-down" : "--nm-warn", palette.line),
      log: true,
      threshold: NETWORK_MAP_LATENCY_WARN_MS,
      axisLabels: ["24 小时前", "现在"],
      palette,
    });
  }, [latency, link.health]);
  const successRate = latency?.successRate ?? null;
  const jitter = latency?.jitter ?? null;
  const hopTotal = link.hopLatencies.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return (
    <>
      <div className="nm-head-card no-flag">
        <div className="nm-meta">
          <div className="nm-line"><Pill tone="link">{link.modeLabel}</Pill><Pill>{link.path.length - 1} 跳</Pill>{link.lastTestAt ? <span>上次诊断 {formatAgo(Date.now() - link.lastTestAt)}</span> : null}</div>
          {issue ? <div className="nm-line"><Pill tone={tone(link.health) === "ok" ? "warn" : tone(link.health)} wrap>{issue}</Pill></div> : null}
        </div>
      </div>
      <Section title="质量监控" count="近 24 小时">
        <div className="nm-metrics">
          <div className="nm-metric wide">
            <div className="nm-label"><span>延迟</span><span className="nm-num">{latency && latency.avg !== null ? `平均 ${Math.round(latency.avg)} · 最高 ${Math.round(latency.max ?? 0)} ms` : latencyLoading ? "读取中…" : "没有历史"}</span></div>
            <div className="nm-value">{latencyNow !== null ? Math.round(latencyNow) : "—"}<small>ms</small></div>
            {latencyError ? <div className="nm-empty">{latencyError}</div> : <canvas ref={latencyRef} className="tall" aria-label="延迟 24 小时走势" />}
          </div>
        </div>
        <div className="nm-gauges" style={{ marginTop: 8 }}>
          <Gauge value={successRate} max={100} unit="%" label="探测成功率" description={successRate === null ? "没有探测记录" : successRate >= 99 ? `${latency?.probeTotal ?? 0} 次探测几乎全通` : successRate >= 95 ? "偶有超时" : "超时较多，可能在丢包"} color={successRate === null ? "--nm-standby" : successRate < 95 ? "--nm-down" : successRate < 99 ? "--nm-warn" : "--nm-ok"} />
          <Gauge value={jitter} max={20} unit="ms" label="抖动" description={jitter === null ? "样本不够" : "延迟样本标准差"} color={jitter === null ? "--nm-standby" : jitter > 10 ? "--nm-warn" : "--nm-ok"} />
        </div>
      </Section>
      <Section title="逐跳" count={link.hopLatencies.some((value) => value !== null) ? `${Math.round(hopTotal)} ms 合计` : "没有逐跳数据"}>
        <div className="nm-hops">
          {link.path.map((hostId, index) => {
            const node = nodeById.get(hostId);
            const hop = link.hopLatencies[index] ?? null;
            const hopTone = hop === null ? "" : hop > NETWORK_MAP_LATENCY_WARN_MS ? " warn" : "";
            return (
              <span key={`${hostId}-${index}`} style={{ display: "contents" }}>
                <button type="button" className="nm-hop" onClick={() => onOpenNode(hostId)} disabled={!node}>{node?.emoji ? `${node.emoji} ` : ""}{node?.name || "看不到的主机"}</button>
                {index < link.path.length - 1 ? <span className={`nm-seg${hopTone}`}><i />{hop === null ? "—" : `${Math.round(hop)} ms`}</span> : null}
              </span>
            );
          })}
        </div>
      </Section>
      <Section title="流量" count="下行 / 上行">
        <div className="nm-bars">
          <TrafficBars label="近 24 小时" pair={traffic.day} />
          <TrafficBars label="累计" pair={traffic.total} />
        </div>
      </Section>
      <Section title="走这条隧道的规则" count={rules.length}>
        {rules.length === 0 ? <div className="nm-empty">还没有规则走这条隧道</div> : (
          <div className="nm-list">
            {rules.map((rule) => (
              <div key={rule.id} className="nm-row is-static">
                <span className="nm-lead" aria-hidden="true">{model.targets.find((target) => target.key === rule.targetKey)?.emoji || "·"}</span>
                <span className="nm-main"><b>{rule.name}</b><span className="nm-num">:{rule.sourcePort} → {rule.targetIp}:{rule.targetPort}</span></span>
                <span className="nm-trail"><Pill tone={tone(rule.health)}>{rule.stopReason || (rule.running ? "运行中" : rule.enabled ? "未运行" : "已停用")}</Pill></span>
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section title="操作">
        <div className="nm-actions">
          <button type="button" className="nm-action" onClick={onDiagnose ?? undefined} disabled={!onDiagnose || diagnosing} title={onDiagnose ? "从入口逐跳探测一遍" : "没有诊断权限"}><Icon name="test" />{diagnosing ? "诊断中…" : "诊断"}</button>
        </div>
      </Section>
    </>
  );
}

function Gauge({ value, max, unit, label, description, color }: { value: number | null; max: number; unit: string; label: string; description: string; color: string }) {
  const circumference = 188.5;
  const ratio = value === null ? 0 : Math.max(0, Math.min(1, value / max));
  const text = value === null ? "—" : unit === "%" ? (value >= 99.95 ? "100" : value.toFixed(value >= 99 ? 1 : 0)) : value.toFixed(1);
  return (
    <div className="nm-gauge">
      <svg viewBox="0 0 76 76" role="img" aria-label={`${label} ${text}${value === null ? "" : unit}`}>
        <circle className="g-track" cx="38" cy="38" r="30" />
        <circle className="g-val" cx="38" cy="38" r="30" stroke={`var(${color})`} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - ratio)} transform="rotate(-90 38 38)" />
        <text className="g-text" x="38" y="41" textAnchor="middle">{text}</text>
        <text className="g-unit" x="38" y="53" textAnchor="middle">{unit}</text>
      </svg>
      <div className="nm-desc"><b>{label}</b><span>{description}</span></div>
    </div>
  );
}

function TrafficBars({ label, pair }: { label: string; pair: { bytesIn: number; bytesOut: number } | null }) {
  const scale = Math.max(1, pair?.bytesIn ?? 0, pair?.bytesOut ?? 0);
  const height = (value: number) => Math.max(4, Math.round((value / scale) * 62));
  return (
    <div className="nm-col">
      <div className="nm-label">{label}</div>
      <div className="nm-stack">
        <div className="nm-b"><i style={{ height: height(pair?.bytesIn ?? 0) }} /><span>↓ {pair ? formatBytesShort(pair.bytesIn) : "—"}</span></div>
        <div className="nm-b"><i className="up" style={{ height: height(pair?.bytesOut ?? 0) }} /><span>↑ {pair ? formatBytesShort(pair.bytesOut) : "—"}</span></div>
      </div>
    </div>
  );
}

// ---------------- 落地目标 ----------------

export type TargetDetailViewProps = {
  model: NetworkMapModel;
  target: NetworkMapTarget;
  onOpenLink: (tunnelId: number) => void;
  onOpenNode: (hostId: number) => void;
};

export function TargetDetailView({ model, target, onOpenLink, onOpenNode }: TargetDetailViewProps) {
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const linkById = new Map(model.links.map((link) => [link.id, link]));
  const rules = model.rules.filter((rule) => rule.targetKey === target.key);
  return (
    <>
      <Section title="指向它的规则" count={rules.length}>
        <div className="nm-list">
          {rules.map((rule: NetworkMapRule) => {
            const link = rule.tunnelId ? linkById.get(rule.tunnelId) : undefined;
            const entry = nodeById.get(rule.hostId);
            const body = (
              <>
                <span className="nm-lead" aria-hidden="true">{entry?.emoji || "·"}</span>
                <span className="nm-main"><b>{rule.name}</b><span>{link ? link.name : `${entry?.name || "主机"} 直连`} · <span className="nm-num">:{rule.sourcePort} → :{rule.targetPort}</span></span></span>
                <span className="nm-trail"><Pill tone={tone(rule.health)}>{rule.stopReason || (rule.running ? "运行中" : rule.enabled ? "未运行" : "已停用")}</Pill></span>
              </>
            );
            return link
              ? <button key={rule.id} type="button" className="nm-row" onClick={() => onOpenLink(link.id)}>{body}</button>
              : <button key={rule.id} type="button" className="nm-row" onClick={() => onOpenNode(rule.hostId)}>{body}</button>;
          })}
        </div>
      </Section>
      <Section title="从哪里出去" count={target.sourceHostIds.length}>
        <div className="nm-list">
          {target.sourceHostIds.map((hostId) => {
            const node = nodeById.get(hostId);
            return node ? <HostRow key={hostId} node={node} onOpen={onOpenNode} /> : null;
          })}
        </div>
      </Section>
      <p className="nm-foot-note">落地目标的位置来自 IP 定位缓存，精确到城市；只有管理员看得到这一层。</p>
    </>
  );
}
