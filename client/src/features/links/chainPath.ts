import type { NetworkEdgeSpec, NetworkNodeSpec } from "@/components/network/NetworkPath";
import { rollUpNetworkHealth, type NetworkHealth } from "@shared/networkHealth";

/**
 * 把一条转发链翻译成路径。
 *
 * 转发链原来渲染成一排带序号的胶囊：
 *
 *   [1. 入口 · Po0] [2. 中转 · Relay-HK] [3. 出口 · Jinx]
 *
 * 三个问题：
 *
 * 一、序号 + 角色名重复说了同一件事。「1.」已经说明它排第一，「入口」再说一遍；
 *     位置本身第三次说了同样的话。三份冗余挤掉的是真正该显示的东西 ——
 *     这一跳连的是哪个地址。
 * 二、胶囊会换行。四跳的链在窄屏上折成两行之后，顺序读起来就断了 ——
 *     而顺序正是这个组件唯一要表达的东西。
 * 三、可用与否用的是 emerald-500 写死的调色板色，和主机页、链路页的绿都不是
 *     同一个绿。
 *
 * 换成 Path 之后顺序由竖排的连线保证，角色由位置表达，状态走统一词汇表。
 */

export type ChainMemberInput = {
  id: number | string;
  /** 这一跳显示什么名字 */
  label: string;
  /** 名字底下那行：连接地址、内网/IPv6 之类的补充 */
  sublabel?: string;
  /** 这一跳此刻是否在生效 */
  active?: boolean;
  /** 明确被停用的成员 */
  enabled?: boolean;
};

export type ChainPathContext = {
  /** 链路外部入口（入口组）。有的话它排在所有成员之前，并且第一个成员不再是「入口」 */
  externalEntryLabel?: string;
  /** 整条链的延迟，标在中间那一段 */
  latencyMs?: number | null;
  /** 探测超时 —— 超时不等于「慢」，是「没通」 */
  isTimeout?: boolean;
};

export type ChainPath = {
  nodes: NetworkNodeSpec[];
  edges: NetworkEdgeSpec[];
  title: string;
};

/**
 * 一跳的状态。
 *
 * 三档分得很清：明确停用是 standby（按设计没在跑），在生效是 healthy，
 * 既没停用又没在生效是 unknown —— **不是 down**。
 *
 * 最后这条是关键：`active` 为 false 的原因可能是「这一跳坏了」，也可能是
 * 「还没探测到这一跳」。把后者显示成红色，等于报一个还不存在的故障。
 */
export function chainMemberHealth(member: ChainMemberInput): NetworkHealth {
  if (member.enabled === false) return "standby";
  if (member.active === true) return "healthy";
  return "unknown";
}

export function buildChainPath(
  members: readonly ChainMemberInput[],
  context: ChainPathContext = {},
): ChainPath {
  const nodes: NetworkNodeSpec[] = [];

  const externalEntry = String(context.externalEntryLabel || "").trim();
  if (externalEntry) {
    nodes.push({
      id: "chain-external-entry",
      name: externalEntry,
      // 入口组是一组机器合起来当一个入口，不写明会被当成单台主机
      sublabel: "入口组",
      health: "healthy",
    });
  }

  members.forEach((member) => {
    nodes.push({
      id: `chain-${member.id}`,
      name: member.label,
      sublabel: member.sublabel || undefined,
      health: chainMemberHealth(member),
    });
  });

  /*
    超时的链路整条画成 down：超时不是「慢」，是「没通」。把它画成 degraded
    （琥珀）会让人以为还能用，只是差一点。
  */
  const middle = nodes.length >= 2 ? Math.max(0, Math.floor((nodes.length - 1) / 2)) : 0;
  const edges: NetworkEdgeSpec[] = nodes.slice(1).map((_, index) => {
    /*
      一段线的状态取它**两端节点里更该被注意的那个**，不是整条链一个颜色。

      第一版是整条链统一 healthy，结果实机上出现了绿线连着两个灰点：线说
      「这一段没问题」，点说「不知道」—— 同一个位置两个互相矛盾的结论。
      而线本来就不携带独立的探测数据，它能说的只有「它连的那两个点怎么样」。

      rollUpNetworkHealth 的排序正好是「最该先看到哪个」，拿来取两端的较差者
      刚好合适。
    */
    const health: NetworkHealth = context.isTimeout
      ? "down"
      : rollUpNetworkHealth([nodes[index].health, nodes[index + 1].health]);
    if (index !== middle) return { health };
    return {
      health,
      latencyMs: typeof context.latencyMs === "number" ? context.latencyMs : undefined,
      via: context.isTimeout ? "探测超时" : undefined,
    };
  });

  const title = [
    nodes.map((node) => node.name).join(" → "),
    context.isTimeout ? "探测超时" : typeof context.latencyMs === "number" ? `延迟 ${context.latencyMs} ms` : "",
  ]
    .filter(Boolean)
    .join("；");

  return { nodes, edges, title };
}
