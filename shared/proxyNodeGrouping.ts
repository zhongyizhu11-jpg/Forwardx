/**
 * 落地节点列表的分组。
 *
 * 节点上十几个之后，一整列平铺的卡片要翻很久才找得到想改的那一个。分组 + 折叠
 * 让常看的那一组留在眼前，其余的收起来。
 *
 * 放在 shared 里是为了能单独测：分组本身是纯计算，掺进组件里就只能靠肉眼看了。
 */

import { PROXY_NODE_PROTOCOLS, PROXY_NODE_PROTOCOL_LABELS, type ProxyNodeProtocol } from "./proxyNode";
import type { ProxyNodeHealthState } from "./proxyNodeHealth";

export const PROXY_NODE_GROUP_MODES = ["none", "protocol", "health"] as const;

export type ProxyNodeGroupMode = (typeof PROXY_NODE_GROUP_MODES)[number];

export const PROXY_NODE_GROUP_MODE_LABELS: Record<ProxyNodeGroupMode, string> = {
  none: "不分组",
  protocol: "按协议",
  health: "按状态",
};

/** 分组只认这几个字段，其余的原样带过去 —— 列表行要用的字段太多，不在这里重复一遍。 */
export type GroupableProxyNode = {
  id: number;
  protocol?: string | null;
  health?: { state?: ProxyNodeHealthState | null } | null;
};

export type ProxyNodeGroup<T> = {
  /** 折叠状态按这个键记住，所以它必须稳定：换个名字不该把折叠状态弄丢。 */
  key: string;
  label: string;
  nodes: T[];
};

const HEALTH_LABELS: Record<ProxyNodeHealthState, string> = {
  offline: "离线",
  online: "在线",
  unknown: "未知",
};

/**
 * 状态分组的排列顺序：离线在最前面。
 *
 * 按状态分组的用处就是找出问题节点，把它们排在第一屏才有意义；
 * 「未知」放最后 —— 那一组多半是没绑转发的节点，看了也没什么可做的。
 */
const HEALTH_ORDER: ProxyNodeHealthState[] = ["offline", "online", "unknown"];

export function normalizeProxyNodeGroupMode(value: unknown): ProxyNodeGroupMode {
  const raw = String(value ?? "").trim().toLowerCase();
  return (PROXY_NODE_GROUP_MODES as readonly string[]).includes(raw)
    ? raw as ProxyNodeGroupMode
    : "none";
}

/**
 * 把节点分成若干组。
 *
 * 组内保持传进来的顺序（也就是用户自己排的 sortOrder），只决定组与组之间怎么排。
 * 空组不出现 —— 一个「Snell (0)」的空标题只是噪音。
 */
export function groupProxyNodes<T extends GroupableProxyNode>(
  nodes: readonly T[],
  mode: ProxyNodeGroupMode,
): ProxyNodeGroup<T>[] {
  if (mode === "none" || nodes.length === 0) {
    return [{ key: "all", label: "全部", nodes: [...nodes] }];
  }

  const buckets = new Map<string, T[]>();
  const push = (key: string, node: T) => {
    const list = buckets.get(key);
    if (list) list.push(node);
    else buckets.set(key, [node]);
  };

  if (mode === "protocol") {
    for (const node of nodes) push(String(node.protocol || "").toLowerCase() || "unknown", node);
    const groups: ProxyNodeGroup<T>[] = [];
    // 先按协议表的固定顺序排，列表才不会因为增删节点而跳来跳去。
    for (const protocol of PROXY_NODE_PROTOCOLS) {
      const list = buckets.get(protocol);
      if (!list) continue;
      groups.push({
        key: `protocol:${protocol}`,
        label: PROXY_NODE_PROTOCOL_LABELS[protocol as ProxyNodeProtocol] || protocol,
        nodes: list,
      });
      buckets.delete(protocol);
    }
    // 认不出来的协议兜底放最后，而不是悄悄丢掉 —— 丢掉的话节点会从界面上消失。
    for (const [key, list] of buckets) {
      groups.push({ key: `protocol:${key}`, label: key === "unknown" ? "其他" : key, nodes: list });
    }
    return groups;
  }

  for (const node of nodes) push(node.health?.state || "unknown", node);
  const groups: ProxyNodeGroup<T>[] = [];
  for (const state of HEALTH_ORDER) {
    const list = buckets.get(state);
    if (!list) continue;
    groups.push({ key: `health:${state}`, label: HEALTH_LABELS[state], nodes: list });
  }
  return groups;
}
