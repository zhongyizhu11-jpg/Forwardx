import type { ReactNode } from "react";

import { EntityTag } from "@/components/entity/EntityCard";
import { cn } from "@/lib/utils";

/*
  编辑框里「按什么选 / 什么时候切」那几块的画法。规则的主备（FailoverPolicyFields）和转发组的
  故障转移（GroupFailoverPolicyFields）共用：同一种说法，也得是同一种长相 —— 此刻起作用的那一行
  左边一根路径色竖条 + 「此刻」，和点开的策略面板一个画法。
*/

export function PolicyGroup({ title, note, children, testId }: { title: string; note?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <h3 className="text-meta font-medium text-muted-foreground">{title}</h3>
      {children}
      {note ? <p className="text-meta leading-relaxed text-muted-foreground">{note}</p> : null}
    </section>
  );
}

/** 「按什么选」里的一层。此刻在起作用的那一层左边一根路径色竖条，和策略面板同一个画法。 */
export function ConditionBlock({
  title,
  detail,
  deciding,
  overridden,
  showTag = true,
  children,
  testId,
}: {
  title: string;
  detail?: ReactNode;
  deciding: boolean;
  overridden?: boolean;
  /** 时段表那一层把「此刻」标在命中的那个时段上，不标在层标题上。 */
  showTag?: boolean;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="relative flex min-w-0 flex-col gap-2 border-t border-[var(--fx-stroke-weak)] py-2.5 pl-3 first:border-t-0 first:pt-0"
      data-state={deciding ? "deciding" : overridden ? "overridden" : "idle"}
      data-testid={testId}
    >
      {deciding ? <span aria-hidden="true" className="absolute bottom-2.5 left-0 top-2.5 w-[3px] rounded-r bg-[var(--fx-path)]" /> : null}
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className={cn("text-secondary-type", deciding ? "font-semibold text-foreground" : "text-foreground")}>{title}</span>
          {detail ? <span className="text-meta text-muted-foreground">{detail}</span> : null}
          {overridden ? <span className="text-meta text-[var(--fx-warn-text)]">此刻本该轮到它，被上面那层压着</span> : null}
        </div>
        {deciding && showTag ? <EntityTag tone="path">此刻</EntityTag> : null}
      </div>
      {children}
    </div>
  );
}
