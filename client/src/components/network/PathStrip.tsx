import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { describeNetworkHealth, type NetworkHealth } from "@shared/networkHealth";

/**
 * 规则卡上的路径条：入口 ── 经过谁 ── 目标。
 *
 * 一条规则最要紧的三件事是「从哪进、经过什么、到哪去」。上一版把它写成一行等宽字
 * `hk-entry.dev:443 ⧉ → 2a0e:97c0:3f4:1::1`，手机上 358px 放不下两个地址，截断之后
 * 剩下 `hk-entry.d… → 2a0e:97c…`，谁也读不出这是从哪到哪。
 *
 * 现在左边一个节点（名字在上、地址在下）、右边一个节点、中间一条线；线的颜色就是这条
 * 规则的状态（天蓝在跑 / 琥珀虚线降级 / 红虚线中断 / 灰虚线停用），线中间一枚小药丸写
 * 经过什么（转发工具 · 协议，或者中继的名字）。两头各自截断，方向由位置说，不靠箭头。
 * 在跑的线上有两颗从左往右走的小点 —— 那是「有流量」，少动效模式下停住。
 *
 * 它和首页网络地图、需要关注列表里的那一小段线是同一套词汇：点是主机，线是关系。
 */
export function PathStrip({
  entry,
  target,
  health = "healthy",
  via,
  hops = [],
  className,
  title,
}: {
  /** 左端：名字（主机 / 隧道 / 转发组）和地址 */
  entry: { name?: ReactNode; address?: ReactNode; title?: string };
  /** 右端：目标地址（名字默认「目标」） */
  target: { name?: ReactNode; address?: ReactNode; title?: string };
  health?: NetworkHealth;
  /** 线中间那枚药丸：转发工具 · 协议 */
  via?: ReactNode;
  /** 中间经过的节点名。有的话药丸写「经 A › B」，工具名退到后面 */
  hops?: readonly string[];
  className?: string;
  title?: string;
}) {
  const descriptor = describeNetworkHealth(health);
  const dashed = descriptor.lineStyle !== "solid";
  const hopText = hops.filter(Boolean).join(" › ");
  return (
    <div className={cn("fx-pathstrip", className)} data-health={health} title={title}>
      <div className="fx-pathstrip-node" title={entry.title}>
        {entry.name ? <b>{entry.name}</b> : null}
        {entry.address ? <span>{entry.address}</span> : null}
      </div>
      <div
        className={cn("fx-pathstrip-wire", dashed && "fx-pathstrip-wire-dashed")}
        style={{ "--fx-pathstrip-color": `var(--fx-${descriptor.token})` } as React.CSSProperties}
        aria-hidden="true"
      >
        {descriptor.token === "healthy" && !dashed ? (
          <>
            <i className="fx-pathstrip-flow" />
            <i className="fx-pathstrip-flow" />
          </>
        ) : null}
        {hops.length > 0 ? hops.map((hop, index) => (
          <i key={`${hop}:${index}`} className="fx-pathstrip-hop" style={{ left: `${((index + 1) / (hops.length + 1)) * 100}%` }} />
        )) : null}
        {hopText || via ? (
          // 手机上药丸里不写跳点名（CSS 藏掉），完整的一句放在 title 里；跳点本身还画在线上。
          <span className="fx-pathstrip-label" title={[hopText ? `经 ${hopText}` : "", typeof via === "string" ? via : ""].filter(Boolean).join(" · ") || undefined}>
            {hopText ? <span className="fx-pathstrip-hops">经 {hopText}</span> : null}
            {hopText && via ? <span className="fx-pathstrip-sep">·</span> : null}
            {via}
          </span>
        ) : null}
      </div>
      <div className="fx-pathstrip-node fx-pathstrip-node-end" title={target.title}>
        <b>{target.name ?? "目标"}</b>
        {target.address ? <span>{target.address}</span> : null}
      </div>
    </div>
  );
}

/**
 * 列表行里的一小段线：「HK entry 01 ──── SG relay 03」。
 *
 * 首页「需要关注」那种一行一件事的列表，说明里出现 A → B 时用它：一条 2px 的线（状态色，
 * 断了就是虚线）比一个箭头字符更像「这两台之间的那条线」。
 */
export function PathLine({
  from,
  to,
  health = "down",
  className,
}: {
  from: ReactNode;
  to: ReactNode;
  health?: NetworkHealth;
  className?: string;
}) {
  const descriptor = describeNetworkHealth(health);
  return (
    <span className={cn("fx-pathline", className)}>
      <span className="truncate">{from}</span>
      <span
        aria-hidden="true"
        className={cn("fx-pathline-ln", descriptor.lineStyle !== "solid" && "fx-pathline-ln-dashed")}
        style={{ "--fx-pathline-color": `var(--fx-${descriptor.token})` } as React.CSSProperties}
      />
      <span className="truncate">{to}</span>
    </span>
  );
}
