import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { StatusDot } from "@/components/network/StatusDot";
import type { NetworkHealth } from "@shared/networkHealth";

/**
 * Entity —— 一个真实业务对象的卡片。
 *
 * ForwardX 只允许三种 Surface：
 *
 *   A  Page Section  页面级大模块（系统状态、实时流量、需要关注）
 *   B  Entity        一个真实业务对象：Host / Tunnel / Rule / Subscription
 *   C  Control       输入框、Select、Segment、Button
 *
 * **只有 B 画框。** Entity 内部的数据组不再用卡片 —— 用间距、分隔线、字号、
 * 一条浅色带来分组就够了。
 *
 * 这条规则要解决的是上一版最典型的「普通后台感」：Card 里面又 Card，里面再有
 * 小 Card。HostCard 一张卡里嵌了资源面板、流量面板、分栏盒三层框，而框本身不
 * 携带任何信息，只是在重复画边界。删掉它们，信息一点没少，视觉噪音少一大半。
 *
 * 各页的 HostCard / TunnelCard / RuleCard / ProxyNodeCard 都由这一组拼出来，
 * 所以视觉统一是**拼出来的**，不是靠全局 CSS 去强行盖出来的。
 */
export function EntityCard({
  interactive = false,
  className,
  children,
  ...rest
}: {
  /** 整张卡可点进详情时传 true —— 列表负责看状态，详情负责看数据 */
  interactive?: boolean;
  className?: string;
  children: ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "children">) {
  return (
    <div
      data-fx-entity="card"
      className={cn(
        "fx-entity-card flex min-w-0 flex-col rounded-[var(--fx-radius-card)] border border-[var(--fx-stroke-base)] bg-[var(--fx-l1-surface)]",
        interactive && "cursor-pointer transition-colors hover:border-[var(--fx-stroke-strong)]",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * 卡头：状态点 + 名字 + 归属 + 右侧控件。
 *
 * 一行里只有一个主角。名字是主角（primary 档、字重 500），归属那一行是注脚
 * （meta 档、muted），不是第二个标题 —— 上一版两者都是 16px/400，同样大同样粗，
 * 一行里没有任何主次。
 */
export function EntityHeader({
  health,
  title,
  subtitle,
  badges,
  trailing,
  className,
}: {
  health?: NetworkHealth;
  title: ReactNode;
  subtitle?: ReactNode;
  /** 名字右边的小标记。**最多两个** —— 再多就该收进详情 */
  badges?: ReactNode;
  /** 右上角：开关、操作菜单 */
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-start gap-2 px-4 pt-4", className)}>
      {health ? <StatusDot health={health} size="large" className="mt-1.5" /> : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-primary-type font-medium text-foreground">{title}</span>
          {badges}
        </div>
        {subtitle ? (
          <span className="truncate text-meta text-muted-foreground">{subtitle}</span>
        ) : null}
      </div>
      {trailing ? <div className="flex shrink-0 items-center gap-1">{trailing}</div> : null}
    </div>
  );
}

/**
 * 卡身：内容区。
 *
 * `band` 给那种需要和上下文分开、但又不值得单独成为一张卡的块（比如转发路径）
 * —— 一条浅色带，没有边框。这是「L2 内容分组不画边框」的落点。
 */
export function EntityBody({
  band = false,
  className,
  children,
}: {
  band?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-3 px-4 py-3",
        band && "bg-[var(--fx-l2-group)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * 卡内分隔线。
 *
 * 替代「再套一个卡片」。左右拉满到卡片边缘（负边距），因为一条缩进的线看起来
 * 像装饰，拉满的线才像「这里分成了两段」。
 */
export function EntityDivider({ className }: { className?: string }) {
  return <div className={cn("mx-4 h-px shrink-0 bg-[var(--fx-stroke-weak)]", className)} />;
}

/**
 * 卡脚：操作区。
 *
 * 一级操作最多 2 个，其余收进 ActionMenu —— 规则写在 EntityActions 里。
 */
export function EntityFooter({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "mt-auto flex min-w-0 items-center justify-end gap-2 border-t border-[var(--fx-stroke-weak)] px-4 py-2",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * 名字旁边那种只读小标记（协议、类型、版本）。
 *
 * 和状态徽标（HealthBadge）分开：状态徽标回答「它现在好不好」，这个回答
 * 「它是什么」。两者长得不一样是故意的 —— 一列卡片扫下去，眼睛要能立刻
 * 分出哪个是状态、哪个是属性。
 */
export function EntityTag({
  children,
  tone,
  className,
}: {
  children: ReactNode;
  /** 只在这个标记本身带语义时才传（比如「备线」用 standby） */
  tone?: "path" | "delivery" | "standby";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-[var(--fx-radius-control)] px-1.5 py-0.5 text-meta",
        className,
      )}
      style={
        tone
          ? { color: `var(--fx-${tone})`, backgroundColor: `var(--fx-${tone}-soft)` }
          : { color: "var(--fx-text-secondary)", backgroundColor: "var(--fx-l2-group)" }
      }
    >
      {children}
    </span>
  );
}
