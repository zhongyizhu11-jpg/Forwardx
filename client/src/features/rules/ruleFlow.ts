import type { NetworkEdgeSpec, NetworkNodeSpec } from "@/components/network/NetworkPath";
import { rollUpNetworkHealth, type NetworkHealth } from "@shared/networkHealth";

/**
 * 一条转发规则的「流」。
 *
 * ── 为什么不是所有规则都画成竖排的 Flow ──
 *
 * V2 的规划里规则卡是这样的：
 *
 *   42.194.198.67:22222
 *           ↓
 *      Po0 ━━━ Jinx
 *           ↓
 *   217.116.172.44:22222
 *
 * 但直连规则的入口和目标之间**什么都没有**。给它画五行去说
 * 「A 转到 B」，而一行 `A ⧉ → B` 已经说完了 —— 多出来的四行不携带信息，
 * 只是在重复箭头。
 *
 * 所以版式跟着数据走：
 *
 *   直连           一行：入口 ⧉ → 目标
 *   隧道/链/组      竖排 Flow：入口 → 经过谁 → 目标
 *
 * 后者的中间那一段正是它和直连的唯一区别，也是这条规则最要紧的信息；
 * 一行的写法根本放不下它。
 *
 * 这不是折中，是同一条原则的两个结果：**版式要让最重要的那件事最显眼**。
 * 直连里最重要的是两个地址，隧道里最重要的是中间经过哪儿。
 */

export type RuleFlowLayout = "inline" | "flow";

/** 规则的四种形态，和 Rules 页的分类一致 */
export type RuleCategory = "local" | "tunnel" | "chain" | "group";

const FLOW_CATEGORIES = new Set(["tunnel", "chain", "group"]);

export function decideRuleFlowLayout(category: RuleCategory | string | null | undefined): RuleFlowLayout {
  /*
    白名单而不是「不是 local 就是 flow」。

    后者在认不出分类时会落到 flow，而 Flow 版式的全部价值在中间那一段 ——
    没有跳点的 Flow 就是一个上下两行加一个箭头，比一行更糟。默认值要选
    那个在任何输入下都不会更差的，那是 inline。
  */
  return FLOW_CATEGORIES.has(String(category || "")) ? "flow" : "inline";
}

export type RuleFlowInput = {
  /** 入口地址（已格式化好，含端口） */
  entry: string;
  /** 目标地址（已格式化好，含端口） */
  target: string;
  /**
   * 中间经过的节点名。直连为空。
   * 隧道是它的跳点，转发链是链上的主机，转发组是组名。
   */
  hops?: readonly string[];
  /** 经过什么转发实现：ForwardX V2 / GOST TLS / realm… */
  via?: string;
  latencyMs?: number | null;
  /** 整条规则的健康状态 */
  health?: NetworkHealth;
};

export type RuleFlow = {
  nodes: NetworkNodeSpec[];
  edges: NetworkEdgeSpec[];
  title: string;
};

/**
 * 构造竖排 Flow 的节点。
 *
 * 入口和目标带注脚说明它们是什么 —— 这里和链路卡不一样：链路卡上一整行都是
 * 主机名，位置足以区分；而这里第一个和最后一个是**地址**、中间是**主机名**，
 * 两种东西混在一列里，不标一下会读成「三台机器」。
 */
export function buildRuleFlow(input: RuleFlowInput): RuleFlow {
  const health = input.health || "unknown";
  const entry = String(input.entry || "").trim();
  const target = String(input.target || "").trim();
  const hops = (input.hops || []).map((hop) => String(hop || "").trim()).filter(Boolean);

  const nodes: NetworkNodeSpec[] = [];
  if (entry) nodes.push({ id: "flow-entry", name: entry, sublabel: "入口", health });
  hops.forEach((hop, index) => {
    nodes.push({ id: `flow-hop-${index}`, name: hop, health });
  });
  if (target) nodes.push({ id: "flow-target", name: target, sublabel: "目标", health });

  /*
    中间那一段标 via 和延迟 —— 和链路卡同一个道理：每段都标会被读成分段延迟，
    而实测的是端到端。

    段的状态取两端节点里更该被注意的那个，不是整条一个颜色：线不携带独立的
    探测数据，它能说的只有「它连的那两个点怎么样」。
  */
  const middle = nodes.length >= 2 ? Math.max(0, Math.floor((nodes.length - 1) / 2)) : 0;
  const edges: NetworkEdgeSpec[] = nodes.slice(1).map((_, index) => {
    const edgeHealth = rollUpNetworkHealth([nodes[index].health, nodes[index + 1].health]);
    if (index !== middle) return { health: edgeHealth };
    return {
      health: edgeHealth,
      via: input.via || undefined,
      latencyMs: typeof input.latencyMs === "number" ? input.latencyMs : undefined,
    };
  });

  const title = [
    [entry, ...hops, target].filter(Boolean).join(" → "),
    input.via || "",
    typeof input.latencyMs === "number" ? `${input.latencyMs} ms` : "",
  ]
    .filter(Boolean)
    .join("；");

  return { nodes, edges, title };
}

/**
 * 规则的运行状态 → 状态词汇表。
 *
 * 面板里规则状态本来就有四档（running / pending / error / disabled），
 * 和六档词汇表的对应是一一的，只有 pending 那一档需要想一下：
 *
 * **pending 是 unknown，不是 degraded。** 「等待 Agent 确认」说的是还没有
 * 结论，不是「有结论，结论是不太好」。画成琥珀会让人去查一个并不存在的问题。
 */
export function ruleVisualStateToHealth(state: string | null | undefined): NetworkHealth {
  switch (String(state || "").toLowerCase()) {
    case "running":
      return "healthy";
    case "error":
      return "down";
    case "disabled":
      return "standby";
    case "pending":
      return "unknown";
    default:
      return "unknown";
  }
}

/**
 * 创建 / 编辑转发时那一块实时预览。
 *
 * 你在方案里写的是「Review 可以在提交按钮上方即时显示」而不是做成 wizard 的
 * 最后一步 —— 这是对的：管理员经常要快速建一条，强制分步会把三秒的事拉成
 * 四屏。放在按钮上方则是白给的：填到哪儿就看到哪儿，不用多点一次。
 *
 * ── 没填完的地方要诚实 ──
 *
 * 预览最容易做坏的地方是**替用户把没填的补上**。比如目标还没填就先画一个
 * 「目标」占位，看起来这条转发已经成立了 —— 然后他点创建，被告诉缺目标地址。
 *
 * 所以没填的那一节画成 unknown（灰点 + 虚线）并写明「待填写」：预览的职责是
 * 「你现在配出来的是这个」，不是「你大概想配这个」。整套状态词汇表里
 * unknown 单列一档，正是为这种场合。
 */
export type RuleFormPreviewInput = {
  category: RuleCategory | string | null | undefined;
  /** 入口地址。还没定下来时传空 */
  entry?: string | null;
  /** 目标地址。还没填时传空 */
  target?: string | null;
  /** 中间节点名。选了隧道/链/组才有 */
  hops?: readonly string[];
  via?: string | null;
};

export function buildRuleFormPreview(input: RuleFormPreviewInput): RuleFlow {
  const entry = String(input.entry || "").trim();
  const target = String(input.target || "").trim();
  const hops = (input.hops || []).map((hop) => String(hop || "").trim()).filter(Boolean);
  const needsHops = decideRuleFlowLayout(input.category) === "flow";

  const nodes: NetworkNodeSpec[] = [
    entry
      ? { id: "preview-entry", name: entry, sublabel: "入口", health: "healthy" as NetworkHealth }
      : { id: "preview-entry", name: "待填写", sublabel: "入口", health: "unknown" as NetworkHealth },
  ];

  if (needsHops) {
    if (hops.length > 0) {
      hops.forEach((hop, index) =>
        nodes.push({ id: `preview-hop-${index}`, name: hop, health: "healthy" as NetworkHealth }),
      );
    } else {
      // 选了「走隧道」但还没选哪条 —— 这一节确实存在，只是还不知道是谁
      nodes.push({ id: "preview-hop-pending", name: "待选择线路", health: "unknown" as NetworkHealth });
    }
  }

  nodes.push(
    target
      ? { id: "preview-target", name: target, sublabel: "目标", health: "healthy" as NetworkHealth }
      : { id: "preview-target", name: "待填写", sublabel: "目标", health: "unknown" as NetworkHealth },
  );

  const middle = Math.max(0, Math.floor((nodes.length - 1) / 2));
  const edges: NetworkEdgeSpec[] = nodes.slice(1).map((_, index) => {
    const health = rollUpNetworkHealth([nodes[index].health, nodes[index + 1].health]);
    return index === middle ? { health, via: input.via || undefined } : { health };
  });

  return {
    nodes,
    edges,
    title: nodes.map((node) => node.name).join(" → "),
  };
}
