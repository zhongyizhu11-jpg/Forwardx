import type { ReactNode } from "react";
import { ArrowDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { HealthBadge, StatusDot } from "@/components/network/StatusDot";
import {
  NetworkEdge,
  NetworkNode,
  NetworkPath,
  PathPreview,
  type NetworkEdgeSpec,
  type NetworkNodeSpec,
} from "@/components/network/NetworkPath";
import { describeNetworkHealth, type NetworkHealth } from "@shared/networkHealth";

/**
 * ForwardX 的路径语言 —— 全站唯一入口。
 *
 * 「入口 → 出口」这件事在面板里有六处在画：隧道页、规则页、转发链、转发组、
 * 链路诊断、创建预览。六处画法都不一样，有的两行带标题竖排，有的一行加箭头，
 * 有的干脆写「入口主机：xxx / 出口主机：yyy」—— 同一个概念六种长相，用户每换
 * 一页就要重新认一次。
 *
 * 而且「入口主机：」这种写法本身就是在**用文字解释空间关系**。空间关系应该由
 * 空间表达：左边那个点就是入口，右边那个点就是出口，中间那条线就是它们的关系。
 *
 * 这个文件不重写一套拓扑系统，而是把原来的 ConnectionPath 升级成一族组件：
 *
 *   ConnectionPath   默认导出，旧的 steps API，已有调用方不用改
 *   PathNode         一个节点
 *   PathEdge         一段连线
 *   PathMetric       线旁边那个数（延迟、带宽）
 *   PathStatus       路径整体的健康徽标
 *   PathBranch       分支：主线 / 备线、多出口
 *   PathPreview      创建流程 Review 那一步的竖排预览
 *
 * 状态画法由 shared/networkHealth.ts 统一给：
 *   绿/琥珀/红/灰 = 健康/降级/故障/待命，实线/虚线/脉冲 = 在走/待命/正在切。
 *
 * 所以以后做主备、负载均衡、多出口都不用设计第二套 UI。
 */

export type ConnectionStep = { label: string; content: ReactNode; key?: string };

export {
  NetworkNode as PathNode,
  NetworkEdge as PathEdge,
  NetworkPath,
  PathPreview,
  type NetworkNodeSpec as PathNodeSpec,
  type NetworkEdgeSpec as PathEdgeSpec,
};

/**
 * 旧的 steps 形态：一列「标题 + 内容」，竖排，带竖轨和箭头。
 *
 * 保留是因为它承载的不全是网络节点 —— 规则页拿它画过「入口 · 点击复制」这种
 * 带交互的行。迁移到 PathNode 要一页一页来，在那之前这个 API 必须继续工作。
 */
export default function ConnectionPath({ steps }: { steps: ConnectionStep[] }) {
  return (
    <ol className="connection-path" aria-label="转发路径">
      {steps.map((step, index) => (
        <li key={step.key ?? index} className="connection-step">
          <span className="connection-rail" aria-hidden="true">
            <span className="connection-node" />
            {index < steps.length - 1 && <ArrowDown className="connection-arrow h-3 w-3" />}
          </span>
          <div className="min-w-0 flex-1">
            <span className="connection-label">{step.label}</span>
            <div className="connection-value">{step.content}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * 线旁边那个数。
 *
 * 和 Metric 的区别是它更小更轻 —— 它是连线的注脚，不是一个独立的指标。
 * 一条路径上挂三个 24px 的大数字，路径本身就看不见了。
 */
export function PathMetric({
  value,
  unit,
  label,
  tone,
  className,
}: {
  value: ReactNode;
  unit?: ReactNode;
  label?: ReactNode;
  tone?: "healthy" | "warn" | "down";
  className?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-baseline gap-1", className)}>
      {label ? <span className="shrink-0 text-meta text-muted-foreground">{label}</span> : null}
      <span
        className="text-meta font-medium tabular-nums"
        style={{ color: tone ? `var(--fx-${tone})` : "var(--fx-text)" }}
      >
        {value}
      </span>
      {unit ? <span className="shrink-0 text-meta text-muted-foreground">{unit}</span> : null}
    </span>
  );
}

/** 整条路径的健康徽标。就是 HealthBadge，换个名字让调用处读起来是路径的事。 */
export const PathStatus = HealthBadge;

export type PathBranchSpec = {
  key: string;
  /** 这条分支的名字：「主线」「备线 1」「Line A」 */
  label: string;
  nodes: readonly NetworkNodeSpec[];
  edges?: readonly NetworkEdgeSpec[];
  health?: NetworkHealth;
  /** 当前正在走的那条。一组分支里应当只有一条为 true */
  active?: boolean;
  /** 右侧补充：延迟、权重、时段 */
  trailing?: ReactNode;
};

/**
 * 分支：主线 / 备线、多出口、负载均衡组。
 *
 * ```
 * A  Po0 ━ Relay-01 ━ Jinx      29ms   ACTIVE
 * B  Po1 · Relay-02 · Jinx      34ms   STANDBY
 * ```
 *
 * 在走的那条用实线和正文色，待命的用虚线和 muted —— 一眼就能看出现在流量在
 * 哪条上，不用读「ACTIVE / STANDBY」这两个词。词只是确认，不是唯一线索：
 * 只靠颜色区分对色觉障碍不友好，所以两者都给。
 *
 * 分支没给 health 时按 active 推断：在走的算 healthy，没在走的算 standby。
 * 这是推断不是结论 —— 真有探测数据时应当显式传 health。
 */
export function PathBranch({
  branches,
  className,
}: {
  branches: readonly PathBranchSpec[];
  className?: string;
}) {
  return (
    <ul className={cn("flex min-w-0 flex-col gap-2", className)} aria-label="线路分支">
      {branches.map((branch) => {
        const health = branch.health || (branch.active ? "healthy" : "standby");
        const descriptor = describeNetworkHealth(health);
        const dimmed = !branch.active;
        return (
          <li
            key={branch.key}
            className={cn(
              "flex min-w-0 flex-col gap-1 rounded-[var(--fx-radius-control)] px-2 py-1.5",
              branch.active && "bg-[var(--fx-network-path-soft,var(--fx-path-soft))]",
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              <StatusDot health={health} />
              <span
                className={cn(
                  "truncate text-secondary-type font-medium",
                  dimmed ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {branch.label}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-2">
                {branch.trailing}
                <span
                  className="text-meta font-medium uppercase tracking-wide"
                  style={{ color: `var(--fx-${descriptor.token})` }}
                >
                  {branch.active ? "ACTIVE" : descriptor.label}
                </span>
              </span>
            </div>
            <NetworkPath
              nodes={branch.nodes}
              edges={
                branch.edges ||
                branch.nodes.slice(1).map(() => ({ health } as NetworkEdgeSpec))
              }
              orientation="horizontal"
              className={dimmed ? "opacity-70" : undefined}
            />
          </li>
        );
      })}
    </ul>
  );
}
