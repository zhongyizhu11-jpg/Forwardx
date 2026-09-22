import { AlertTriangle, CheckCircle2, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";

import { countAttentionDegraded, type DashboardAttention } from "@shared/dashboardAttention";
import { formatBytes } from "@shared/formatBytes";
import { cn } from "@/lib/utils";

/** Health reflects current API data; status colors are reserved for actual conditions. */

export type SystemHealth = {
  hosts: { total: number; online: number; offline: number; neverConnected: number };
  links: { total: number; healthy: number; unhealthy: number; degraded?: number };
  forwards: { total: number; running: number; stalled: number; paused?: number; disabled: number };
  issues: number;
  /** 这几个数背后具体是谁。首页下面那块「需要关注」画的就是它 */
  attention?: DashboardAttention;
};

type Props = {
  health?: SystemHealth;
  /**
   * 近 24 小时流量（字节）。没有数据时传 undefined，不要传 0 —— 那是两回事。
   *
   * 叫「近 24H」而不是「今日」：数据是最近 24 小时的滚动窗口，不是从零点算起。
   * 两者在下午三点能差出大半天的量，而页面下方那张图本来就叫「近 24H」，
   * 顶上写「今日」会让同一份数据在同一屏里有两个名字。
   */
  recentBytes?: number;
  loading?: boolean;
  isAdmin: boolean;
  onRetry?: () => void;
};

/** 一项指标：主数字 + 一句从属说明。说明为空时不占位。 */
function Metric({ label, value, note, tone }: {
  label: string;
  value: string | number;
  note?: string | null;
  tone?: "normal" | "warn";
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="truncate text-2xl font-semibold tabular-nums tracking-tight">{value}</span>
        {note ? (
          <span className={cn("truncate text-xs", tone === "warn" ? "text-[var(--fx-warn-text)]" : "text-muted-foreground")}>
            {note}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 首页最上面那一块：现在系统是否正常。
 *
 * 顶上一行的判定按「最该先看到哪个」退档：有异常说异常；没有异常但有降级，说
 * 降级 —— 不能在下面列表里挂着琥珀色的同时写「运行正常」；都没有才说正常。
 * 「还没接入」的主机两边都不算：那是一步没做完，不是出了事，它只进下面的列表。
 */
function headline(health: SystemHealth) {
  const issues = Math.max(0, Number(health.issues) || 0);
  if (issues > 0) return { text: `${issues} 处异常`, tone: "warn" as const };
  const degraded = health.attention
    ? countAttentionDegraded(health.attention.totals)
    : Math.max(0, Number(health.links.degraded) || 0);
  if (degraded > 0) return { text: `${degraded} 处降级`, tone: "warn" as const };
  return { text: "运行正常", tone: "healthy" as const };
}

export default function SystemStatusHeader({ health, recentBytes, loading, isAdmin, onRetry }: Props) {
  const empty = !!health && health.hosts.total === 0 && health.links.total === 0 && health.forwards.total === 0;
  const verdict = health && !empty ? headline(health) : null;
  const linkDegraded = Math.max(0, Number(health?.links.degraded) || 0);
  const forwardPaused = Math.max(0, Number(health?.forwards.paused) || 0);

  return (
    /*
      一块纯白、不描边的面，和页面浅灰底拉开 —— 和全站的卡片同一套（灰底托白卡）。
      上一版这里还自己描着一圈边、带着投影，是全站唯一一块没跟上的。
    */
    <section className="system-health p-4 sm:p-5">
      <div className="flex items-start gap-3">
        {loading && !health ? (
          <span className="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-muted" aria-hidden="true" />
        ) : empty ? (
          <Layers className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : verdict?.tone === "healthy" ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[var(--fx-healthy-text)]" aria-hidden="true" />
        ) : verdict ? (
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--fx-warn-text)]" aria-hidden="true" />
        ) : null}
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight sm:text-xl">
            {loading && !health ? "检查中" : !health ? "暂时无法读取状态" : empty ? "准备好，开始你的第一条连接" : verdict?.text}
          </h2>
          {/*
            异常是哪几处，不再在这里用一行字概括（「1 台主机掉线 · 1 条线路异常」）——
            下面的「需要关注」逐条列出来了，点得进去。同一件事说两遍，读起来就是重。
            正常时也不补一句「一切都好」—— 那是废话。
          */}
          {empty && <p className="mt-2 text-sm leading-6 text-muted-foreground">{isAdmin ? "先接入主机，再配置链路，最后创建转发规则。" : "获得可用线路后，就可以创建转发规则。需要资源权限时请联系管理员。"}</p>}
          {!loading && !health && onRetry && <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>重新读取</Button>}
        </div>
      </div>

      <div className={cn(
        "mt-4 grid gap-4 border-t pt-4",
        isAdmin ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-2 sm:grid-cols-3",
      )}>
        {isAdmin ? (
          <Metric
            label="主机"
            value={health?.hosts.total ?? "—"}
            note={health ? `${health.hosts.online} 在线` : null}
            tone={health && health.hosts.offline > 0 ? "warn" : "normal"}
          />
        ) : null}
        <Metric
          label="线路"
          value={health?.links.total ?? "—"}
          note={health
            ? health.links.unhealthy > 0
              ? `${health.links.unhealthy} 异常`
              : linkDegraded > 0
                ? `${linkDegraded} 降级`
                : `${health.links.healthy} 正常`
            : null}
          tone={health && (health.links.unhealthy > 0 || linkDegraded > 0) ? "warn" : "normal"}
        />
        <Metric
          label="转发"
          value={health?.forwards.total ?? "—"}
          note={health
            ? health.forwards.stalled > 0
              ? `${health.forwards.stalled} 未运行`
              : forwardPaused > 0 && !isAdmin
                ? `${forwardPaused} 已暂停`
                : `${health.forwards.running} 运行中`
            : null}
          tone={health && (health.forwards.stalled > 0 || (forwardPaused > 0 && !isAdmin)) ? "warn" : "normal"}
        />
        <Metric
          label="近 24H 流量"
          value={recentBytes === undefined ? "—" : formatBytes(recentBytes)}
        />
      </div>
    </section>
  );
}
