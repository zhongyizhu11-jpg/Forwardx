import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { formatBytes } from "@shared/formatBytes";
import { cn } from "@/lib/utils";

/**
 * 首页最上面那一行：现在系统是否正常。
 *
 * 这里原来是一个写死的绿色「系统在线」徽章 —— 后面没有任何数据，掉多少台机器
 * 它都是绿的。整个首页唯一该回答那个问题的地方，是个装饰。
 *
 * 现在的规矩很简单：**有异常就说异常，没有才说正常**，而且异常数点得出来自哪。
 * 三类分开数，因为处理方式不一样：掉线要去看机器，线路不健康要去看链路，
 * 转发该跑没跑通常是配置没下发下去。
 *
 * 刻意不做的事：不加渐变、不加阴影、不加动效。一行字号拉开层级，其余靠留白。
 * 状态色只用在真正表示状态的那一个点上 —— 四张卡片各配一种渐变色的做法，
 * 会让人分不清哪个颜色是有含义的。
 */

export type SystemHealth = {
  hosts: { total: number; online: number; offline: number; neverConnected: number };
  links: { total: number; healthy: number; unhealthy: number };
  forwards: { total: number; running: number; stalled: number; disabled: number };
  issues: number;
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
          <span className={cn("truncate text-xs", tone === "warn" ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground")}>
            {note}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export default function SystemStatusHeader({ health, recentBytes, loading, isAdmin }: Props) {
  const issues = Math.max(0, Number(health?.issues) || 0);
  const healthy = !!health && issues === 0;

  /**
   * 异常那一句要说得出是哪一类，否则「3 个异常」等于让人去三个页面挨个找。
   * 只列真正大于零的那几类。
   */
  const parts: string[] = [];
  if (health) {
    if (health.hosts.offline > 0) parts.push(`${health.hosts.offline} 台主机掉线`);
    if (health.links.unhealthy > 0) parts.push(`${health.links.unhealthy} 条线路异常`);
    if (health.forwards.stalled > 0) parts.push(`${health.forwards.stalled} 条转发未运行`);
  }

  return (
    <section className="rounded-lg border bg-card p-4 sm:p-5">
      <div className="flex items-start gap-3">
        {loading || !health ? (
          <span className="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-muted" aria-hidden="true" />
        ) : healthy ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-500" aria-hidden="true" />
        ) : (
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-500" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight sm:text-xl">
            {loading || !health ? "检查中" : healthy ? "运行正常" : `${issues} 处异常`}
          </h1>
          {/*
            正常时不再补一句「一切都好」—— 那是废话。异常时才需要这一行，
            而它必须说清是哪一类，不然这个数字只是让人去三个页面挨个找。
          */}
          {!loading && health && parts.length > 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">{parts.join(" · ")}</p>
          ) : null}
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
          note={health ? (health.links.unhealthy > 0 ? `${health.links.unhealthy} 异常` : `${health.links.healthy} 正常`) : null}
          tone={health && health.links.unhealthy > 0 ? "warn" : "normal"}
        />
        <Metric
          label="转发"
          value={health?.forwards.total ?? "—"}
          note={health ? (health.forwards.stalled > 0 ? `${health.forwards.stalled} 未运行` : `${health.forwards.running} 运行中`) : null}
          tone={health && health.forwards.stalled > 0 ? "warn" : "normal"}
        />
        <Metric
          label="近 24H 流量"
          value={recentBytes === undefined ? "—" : formatBytes(recentBytes)}
        />
      </div>
    </section>
  );
}
