/**
 * 「有额度的东西到量了」这件事，一处判定、两个渠道发。
 *
 * 面板里能设总流量的一共三层，口径各不相同：
 *
 *   - **主机**：机房账单口径（系统级网卡计数）。跑超是机房停机。
 *   - **落地端口**（proxy_inbounds）：面板自己在这台机器上开的那个监听端口，
 *     Agent 的计数链就装在它上面。
 *   - **落地节点**（proxy_nodes）：用户粘进来的那一条，额度通常抄自机房套餐。
 *
 * 主机那一层有自己的提醒（含续费，走 runHostEmailReminders）。剩下两层的判定
 * 完全一样 —— 都是「已用 / 总量 到没到阈值」—— 而原来只有节点那一层会发：端口
 * 有额度、有累加、行上到量会变红，**唯独不提醒**。填了 500G 的人以为面板在看着，
 * 其实只有他自己盯着那一页时才看得见。
 *
 * 所以这里不是「再抄一份给端口」，而是把两层收进同一个清单：判定共用
 * shared/proxyNodeReminder（也就是界面上那个仪表盘的同一个阈值），邮件和
 * Telegram 两路都遍历它。三处各算一套的话，迟早出现「图标还是绿的、邮件说快满了」。
 *
 * 到量**不停服**，只告诉主人 —— 和节点那一层同一个决定：这个数多半是机房规格，
 * 真正会断的是机房那一刀，面板抢先停掉只会让人莫名其妙少几条线路。
 */

import * as db from "./db";
import {
  planProxyNodeTrafficReminder,
  proxyTrafficReminderKey,
  type ProxyTrafficReminderScope,
} from "../shared/proxyNodeReminder";
import type { ProxyNodeTrafficReminder } from "../shared/proxyNodeReminder";

export type ProxyTrafficReminderSubject = {
  scope: ProxyTrafficReminderScope;
  id: number;
  userId: number;
  /** 「落地节点」/「落地端口」，直接进标题。 */
  kindText: string;
  /** 给人认出是哪一个：节点名，或「端口名（主机名:端口）」。 */
  label: string;
  plan: ProxyNodeTrafficReminder;
  /** 去重键的正文，调用方各自加 `emailReminder:` / `telegramReminder:` 前缀。 */
  dedupeKey: string;
};

function placeText(hostName: string, port: unknown): string {
  const host = String(hostName || "").trim();
  const portText = Math.floor(Number(port) || 0);
  if (host && portText > 0) return `${host}:${portText}`;
  if (host) return host;
  return portText > 0 ? `:${portText}` : "";
}

/**
 * 收齐两层里「今天该提醒」的那些。
 *
 * 只查设了总量的行（两个仓储函数各自带 `trafficLimit > 0`），没填的谈不上到量。
 */
export async function collectDueProxyTrafficReminders(): Promise<ProxyTrafficReminderSubject[]> {
  const subjects: ProxyTrafficReminderSubject[] = [];

  const nodes = (await db.getProxyNodesWithTrafficQuota()) as any[];
  for (const node of nodes) {
    const plan = planProxyNodeTrafficReminder(node);
    if (!plan.due) continue;
    const id = Number(node.id);
    const name = String(node.name || "").trim() || `#${id}`;
    const place = placeText(String(node.address || ""), node.port);
    subjects.push({
      scope: "node",
      id,
      userId: Number(node.userId),
      kindText: "落地节点",
      label: place ? `${name}（${place}）` : name,
      plan,
      dedupeKey: proxyTrafficReminderKey("node", id, plan.state),
    });
  }

  const inbounds = (await db.getProxyInboundsWithTrafficQuota()) as any[];
  const dueInbounds = inbounds.filter((inbound) => planProxyNodeTrafficReminder(inbound).due);
  if (dueInbounds.length > 0) {
    const hostNames = await db.getHostNamesByIds(dueInbounds.map((inbound) => Number(inbound.hostId)));
    for (const inbound of dueInbounds) {
      const id = Number(inbound.id);
      const name = String(inbound.name || "").trim() || `#${id}`;
      const place = placeText(hostNames.get(Number(inbound.hostId)) || "", inbound.port);
      subjects.push({
        scope: "inbound",
        id,
        userId: Number(inbound.userId),
        kindText: "落地端口",
        label: place ? `${name}（${place}）` : name,
        plan: planProxyNodeTrafficReminder(inbound),
        dedupeKey: proxyTrafficReminderKey("inbound", id, planProxyNodeTrafficReminder(inbound).state),
      });
    }
  }

  return subjects;
}

/** 标题与正文两个渠道共用，省得哪天只改了一边。 */
export function proxyTrafficReminderTitle(subject: ProxyTrafficReminderSubject): string {
  return subject.plan.state === "exceeded"
    ? `ForwardX ${subject.kindText}流量已用完`
    : `ForwardX ${subject.kindText}流量提醒`;
}

export function proxyTrafficReminderTail(subject: ProxyTrafficReminderSubject): string {
  return subject.plan.state === "exceeded"
    ? "面板不会因此停掉它，但机房通常会 —— 到时候客户端里这条线路会直接断。"
    : "跑超之后机房通常会停机，客户端里这条线路会直接断，建议提前处理。";
}
