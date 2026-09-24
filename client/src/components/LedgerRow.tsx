import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 手机上的一条流水：左边是哪一笔，右边多少钱。
 *
 * 流水在桌面上是五六列的表格；原样搬到 393px 上，表格为了塞下六列，把「类型」那一列
 * 压到一个字宽 —— 徽标里的「余额充值」变成一个字一行竖着排（账单中心实测）。手机上
 * 不画表：一条两行，名称和金额在第一行，类型、状态、时间在第二行。看流水的人先找的是
 * 「哪一笔、多少钱」，其余的是补充。
 *
 * 行与行之间的线由 .fx-list-row 画（和分组列表同一条线）。
 */
export function LedgerRow({
  icon,
  title,
  meta,
  amount,
  amountClassName,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  /** 第二行：类型 · 状态 · 时间这类，放不下就折行，不截断 —— 截掉的往往是时间。 */
  meta?: ReactNode;
  amount?: ReactNode;
  /** 金额的颜色（进账绿、出账红，由调用方按同一份规则给）。 */
  amountClassName?: string;
  className?: string;
}) {
  return (
    <div className={cn("fx-list-row flex min-w-0 items-start gap-3 py-3", className)}>
      {icon ? (
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--fx-radius-control)] bg-[var(--fx-l3-control-fill)] text-muted-foreground">
          {icon}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-secondary-type font-medium text-foreground">{title}</span>
        {meta ? <span className="text-meta leading-relaxed text-muted-foreground">{meta}</span> : null}
      </span>
      {amount !== undefined && amount !== null ? (
        <span className={cn("shrink-0 text-secondary-type font-semibold tabular-nums", amountClassName)}>{amount}</span>
      ) : null}
    </div>
  );
}

/** 「类型 · 状态 · 时间」：空的那几项不写，不留「 ·  · 」。 */
export function ledgerMeta(...parts: Array<string | null | undefined | false>) {
  return parts.filter((part): part is string => !!part && part !== "-").join(" · ");
}
