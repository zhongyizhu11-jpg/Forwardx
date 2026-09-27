import type { ReactNode } from "react";

import { Sparkline } from "@/components/charts/Sparkline";

/**
 * 页头标题下面那一行状态点：「● 运行 5 · ● 停用 0 · ● 异常 0」。
 *
 * 一个点一个数，颜色和列表里的状态点是同一套词汇 —— 这里绿的，卡上也是绿的。数是 0 的
 * 那一项整体变灰（点仍在，告诉人这一类存在但现在没有）。它回答的是「这一页现在什么状况」，
 * 不是筛选：要筛用下面的分类条。
 */
export type HeaderChip = {
  key: string;
  label: ReactNode;
  count: number;
  tone?: "healthy" | "warn" | "down" | "path" | "off";
  /** 平时不显示、只在数不为 0 时出现的项（「可升级 1」）。 */
  onlyWhenPresent?: boolean;
};

export function HeaderStatusChips({ items }: { items: HeaderChip[] }) {
  return (
    <>
      {items
        .filter((item) => !item.onlyWhenPresent || item.count > 0)
        .map((item) => (
          <span key={item.key} className="fx-head-chip" data-tone={item.tone ?? "off"} data-zero={item.count === 0 ? "" : undefined}>
            <i aria-hidden="true" />
            <span>{item.label}</span>
            <b>{item.count}</b>
          </span>
        ))}
    </>
  );
}

/** 页头右上角：一条 96×22 的小走势和它底下一行数（「近 24H ↓ 127.9 MB · ↑ 735.4 MB」）。 */
export function HeaderSpark({ values, caption, title }: { values: number[]; caption: ReactNode; title?: string }) {
  return (
    <>
      <Sparkline values={values} width={96} height={22} title={title} />
      <span>{caption}</span>
    </>
  );
}
