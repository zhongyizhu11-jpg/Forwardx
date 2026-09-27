import { ArrowRight, ArrowRightLeft, Route, Server } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SummaryStrip, type SummaryItem } from "@/components/entity/SummaryStrip";
import { countAttentionDegraded, type DashboardAttention } from "@shared/dashboardAttention";
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
  loading?: boolean;
  isAdmin: boolean;
  onRetry?: () => void;
  /** 「查看需要关注」按钮：有异常时跳到下面那块列表 */
  onOpenAttention?: () => void;
};

/**
 * 首页最上面那一块：现在系统是否正常。
 *
 * 结论按「最该先看到哪个」退档：有异常说异常；没有异常但有降级，说降级 ——
 * 不能在下面列表里挂着琥珀色的同时写「运行正常」；都没有才说正常。
 * 「还没接入」的主机两边都不算：那是一步没做完，不是出了事，它只进下面的列表。
 */
function headline(health: SystemHealth) {
  const issues = Math.max(0, Number(health.issues) || 0);
  if (issues > 0) return { text: `${issues} 处需要关注`, tone: "warn" as const };
  const degraded = health.attention
    ? countAttentionDegraded(health.attention.totals)
    : Math.max(0, Number(health.links.degraded) || 0);
  if (degraded > 0) return { text: `${degraded} 处降级`, tone: "warn" as const };
  return { text: "运行正常", tone: "healthy" as const };
}

/**
 * 一行三个数（主机 / 线路 / 转发）加一行结论。
 *
 * 上一版是「运行概况」标题 + 一句说明 + 三张带框的小卡 + 右边一块三色渐变的结论面板，
 * 手机上整块 250px，而它说的只有两件事：几个数、有没有事。现在数字走 SummaryStrip
 * 那种不画框的统计行，结论是一行字：绿点「运行正常」，或者琥珀点「N 处需要关注」加
 * 一个「查看」。哪几处出了事，下面「需要关注」逐条列，这里不再解释。
 */
export default function SystemStatusHeader({ health, loading, isAdmin, onRetry, onOpenAttention }: Props) {
  const empty = !!health && health.hosts.total === 0 && health.links.total === 0 && health.forwards.total === 0;
  const verdict = health && !empty ? headline(health) : null;
  const linkDegraded = Math.max(0, Number(health?.links.degraded) || 0);
  const forwardPaused = Math.max(0, Number(health?.forwards.paused) || 0);

  const items: SummaryItem[] = [
    ...(isAdmin ? [{
      key: "hosts",
      label: "主机",
      icon: Server,
      value: health?.hosts.total ?? "—",
      hint: health ? (health.hosts.offline > 0 ? `${health.hosts.offline} 离线` : `${health.hosts.online} 在线`) : null,
      hintTone: health ? (health.hosts.offline > 0 ? "warn" : "healthy") : undefined,
    } satisfies SummaryItem] : []),
    {
      key: "links",
      label: "线路",
      icon: Route,
      value: health?.links.total ?? "—",
      hint: health
        ? health.links.unhealthy > 0
          ? `${health.links.unhealthy} 异常`
          : linkDegraded > 0
            ? `${linkDegraded} 降级`
            : `${health.links.healthy} 正常`
        : null,
      hintTone: health ? (health.links.unhealthy > 0 ? "down" : linkDegraded > 0 ? "warn" : "healthy") : undefined,
    },
    {
      key: "forwards",
      label: "转发",
      icon: ArrowRightLeft,
      value: health?.forwards.total ?? "—",
      hint: health
        ? health.forwards.stalled > 0
          ? `${health.forwards.stalled} 未运行`
          : forwardPaused > 0 && !isAdmin
            ? `${forwardPaused} 已暂停`
            : `${health.forwards.running} 运行中`
        : null,
      hintTone: health
        ? (health.forwards.stalled > 0 ? "warn" : forwardPaused > 0 && !isAdmin ? "warn" : "healthy")
        : undefined,
    },
  ];

  const verdictTone: "healthy" | "warn" | "muted" = loading && !health ? "muted" : !health ? "warn" : empty ? "muted" : verdict?.tone ?? "muted";
  const verdictTitle = loading && !health ? "检查中" : !health ? "暂时无法读取状态" : empty ? "准备好，开始你的第一条连接" : verdict?.text;
  const verdictDetail = empty
    ? (isAdmin ? "先接入主机，再配置线路，最后创建转发规则。" : "获得可用线路后，就可以创建转发规则。需要资源权限时请联系管理员。")
    : null;

  return (
    <section className="system-health flex min-w-0 flex-col gap-3" aria-label="运行状态">
      <SummaryStrip items={items} loading={!!loading && !health} ariaLabel="主机、线路、转发数量" />
      <div
        className="system-health-verdict flex min-w-0 items-center gap-3 rounded-[var(--fx-radius-card)] border border-[var(--fx-stroke-weak)] px-3.5 py-2.5"
        data-tone={verdictTone}
        role="status"
      >
        <span
          aria-hidden="true"
          className={cn("h-2.5 w-2.5 shrink-0 rounded-full", verdictTone === "muted" && "bg-[var(--fx-standby)]")}
          style={verdictTone === "muted" ? undefined : {
            backgroundColor: `var(--fx-${verdictTone})`,
            boxShadow: `0 0 0 3px var(--fx-${verdictTone}-soft)`,
          }}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-primary-type font-semibold tracking-tight text-foreground">{verdictTitle}</span>
          {verdictDetail ? <span className="text-meta text-muted-foreground">{verdictDetail}</span> : null}
        </span>
        {!loading && !health && onRetry ? (
          <Button variant="outline" size="sm" className="shrink-0" onClick={onRetry}>重新读取</Button>
        ) : verdict && verdict.tone !== "healthy" && onOpenAttention ? (
          <Button variant="ghost" size="sm" className="shrink-0 gap-1 px-2 text-[var(--fx-accent)] hover:text-[var(--fx-accent)]" onClick={onOpenAttention}>
            查看
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </section>
  );
}
