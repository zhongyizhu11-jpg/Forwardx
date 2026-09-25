import { AlertTriangle, ArrowRight, ArrowRightLeft, CheckCircle2, Layers, Route, Server, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IconBadge, type IconBadgeTone } from "@/components/ui/icon-badge";
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
 * 一格统计：图标底座 + 标签一行，下面等宽字体的大数，再下面一句从属说明。
 * 照参考站（New API / Vexo）首页的 StatCard 画。
 */
function StatTile({ icon: Icon, tone, label, value, note, warn }: {
  icon: LucideIcon;
  tone: IconBadgeTone;
  label: string;
  value: string | number;
  note?: string | null;
  warn?: boolean;
}) {
  return (
    <div className="fx-summary-cell flex min-w-0 flex-col gap-1 rounded-[var(--fx-radius-card)] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] px-2 py-2 sm:gap-1.5 sm:p-3">
      <div className="flex min-w-0 items-center gap-1.5 text-meta font-medium text-muted-foreground sm:gap-2">
        <IconBadge tone={warn ? "warn" : tone}><Icon /></IconBadge>
        <span className="truncate">{label}</span>
      </div>
      <div className="fx-summary-value truncate font-mono font-semibold tabular-nums tracking-tight">{value}</div>
      {note ? (
        <div className={cn("truncate text-meta", warn ? "text-[var(--fx-warn-text)]" : "text-muted-foreground")}>{note}</div>
      ) : null}
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

/**
 * 照参考站（New API / Vexo）首页的 summary card 排：左边是「概况」—— 标题、一句说明、
 * 一排统计格；右边一块带淡淡渐变的面，写此刻的结论（运行正常 / N 处异常）和一个去
 * 处理的按钮。宽屏并排，手机上结论那块折到统计格上面 —— 手机上先看结论。
 */
export default function SystemStatusHeader({ health, loading, isAdmin, onRetry, onOpenAttention }: Props) {
  const empty = !!health && health.hosts.total === 0 && health.links.total === 0 && health.forwards.total === 0;
  const verdict = health && !empty ? headline(health) : null;
  const linkDegraded = Math.max(0, Number(health?.links.degraded) || 0);
  const forwardPaused = Math.max(0, Number(health?.forwards.paused) || 0);
  const issueCount = Math.max(0, Number(health?.issues) || 0);

  const verdictTitle = loading && !health ? "检查中" : !health ? "暂时无法读取状态" : empty ? "准备好，开始你的第一条连接" : verdict?.text;
  const verdictIcon = loading && !health ? (
    <span className="h-2 w-2 shrink-0 rounded-full bg-muted" aria-hidden="true" />
  ) : empty ? (
    <Layers className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
  ) : verdict?.tone === "healthy" ? (
    <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--fx-healthy-text)]" aria-hidden="true" />
  ) : verdict ? (
    <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--fx-warn-text)]" aria-hidden="true" />
  ) : null;

  return (
    <section className="system-health overflow-hidden">
      <div className="grid xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="order-2 flex flex-col gap-2.5 p-3 sm:gap-3 sm:p-4 xl:order-1">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-secondary-type font-semibold text-foreground">运行概况</h2>
            <p className="text-meta text-muted-foreground">主机、线路和转发此刻的数量与状态。</p>
          </div>
          <div className={cn("grid gap-2 sm:gap-3", isAdmin ? "grid-cols-3" : "grid-cols-2")}>
            {isAdmin ? (
              <StatTile
                icon={Server}
                tone="chart-1"
                label="主机"
                value={health?.hosts.total ?? "—"}
                note={health ? `${health.hosts.online} 在线` : null}
                warn={!!health && health.hosts.offline > 0}
              />
            ) : null}
            <StatTile
              icon={Route}
              tone="chart-2"
              label="线路"
              value={health?.links.total ?? "—"}
              note={health
                ? health.links.unhealthy > 0
                  ? `${health.links.unhealthy} 异常`
                  : linkDegraded > 0
                    ? `${linkDegraded} 降级`
                    : `${health.links.healthy} 正常`
                : null}
              warn={!!health && (health.links.unhealthy > 0 || linkDegraded > 0)}
            />
            <StatTile
              icon={ArrowRightLeft}
              tone="chart-3"
              label="转发"
              value={health?.forwards.total ?? "—"}
              note={health
                ? health.forwards.stalled > 0
                  ? `${health.forwards.stalled} 未运行`
                  : forwardPaused > 0 && !isAdmin
                    ? `${forwardPaused} 已暂停`
                    : `${health.forwards.running} 运行中`
                : null}
              warn={!!health && (health.forwards.stalled > 0 || (forwardPaused > 0 && !isAdmin))}
            />
          </div>
        </div>

        {/*
          结论那一块：参考站右侧那块「余额」面板的位置。底是三团很淡的图表色渐变 ——
          整张白纸上唯一一块有颜色的面，眼睛先落在这里。
        */}
        <div className="system-health-verdict order-1 flex flex-col justify-between gap-3 border-b border-[var(--fx-stroke-weak)] p-3 sm:p-4 xl:order-2 xl:border-b-0 xl:border-l">
          <div className="flex flex-col gap-1.5">
            <span className="text-meta font-medium text-muted-foreground">当前状态</span>
            <div className="flex items-center gap-2">
              {verdictIcon}
              <span className="text-primary-type font-semibold tracking-tight text-foreground">{verdictTitle}</span>
            </div>
            {empty ? (
              <p className="text-meta leading-relaxed text-muted-foreground">
                {isAdmin ? "先接入主机，再配置链路，最后创建转发规则。" : "获得可用线路后，就可以创建转发规则。需要资源权限时请联系管理员。"}
              </p>
            ) : verdict && verdict.tone !== "healthy" ? (
              <p className="text-meta leading-relaxed text-muted-foreground">具体是哪几处，下面「需要关注」逐条列出来了。</p>
            ) : verdict ? (
              <p className="text-meta leading-relaxed text-muted-foreground">主机在线、线路正常、转发都在跑。</p>
            ) : null}
          </div>
          {!loading && !health && onRetry ? (
            <Button variant="outline" size="sm" className="w-fit" onClick={onRetry}>重新读取</Button>
          ) : verdict && verdict.tone !== "healthy" && onOpenAttention ? (
            <Button size="sm" className="w-fit gap-1.5" onClick={onOpenAttention}>
              查看 {issueCount > 0 ? `${issueCount} 处` : ""}需要关注
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
