/**
 * ForwardX 的状态词汇表 —— 整个系统只有这一份。
 *
 * 面板上的点、徽标、连线，Telegram 推送里的文字，服务端算出来的摘要，说的
 * 必须是同一件事。上一版不是这样：面板用 online/warning/offline 三档、隧道页
 * 自己判 isRunning/isEnabled、Telegram 又有一套措辞，结果同一条规则在面板上
 * 是「正常」在 Telegram 里是「未确认」。
 *
 * 六个状态，含义互斥：
 *
 *   healthy    在跑，探测通过
 *   degraded   在跑，但指标越界（延迟偏高、丢包、接近配额）
 *   down       该跑没跑，或探测失败
 *   standby    按设计就没在跑：备线、手动停用
 *   switching  正在切换，是个瞬时态
 *   unknown    **没有结论**
 *
 * `unknown` 单列一档是这套词汇表最重要的一条约定。
 *
 * 「没上报过」不等于「正常」。把没有结论的东西显示成绿色，等于让一台已经
 * 失联的机器看起来健康 —— 这是监控类产品最不该犯的错。所以任何判定函数
 * 拿不到数据时一律回 unknown，绝不回 healthy。
 */

export type NetworkHealth =
  | "healthy"
  | "degraded"
  | "down"
  | "standby"
  | "switching"
  | "unknown";

/** 连线的画法。实线=在走，虚线=待命，脉冲=正在切。 */
export type NetworkLineStyle = "solid" | "dashed" | "pulse";

export type NetworkHealthDescriptor = {
  health: NetworkHealth;
  /** 中文短标签，列表和徽标上直接用 */
  label: string;
  /** 语义色的令牌名，对应 design-tokens.css 里那一组 */
  token: "healthy" | "warn" | "down" | "standby" | "path";
  lineStyle: NetworkLineStyle;
  /** 是否算「需要处理」—— 首页「需要关注」那一块靠它筛 */
  needsAttention: boolean;
};

const DESCRIPTORS: Record<NetworkHealth, NetworkHealthDescriptor> = {
  healthy: { health: "healthy", label: "正常", token: "healthy", lineStyle: "solid", needsAttention: false },
  degraded: { health: "degraded", label: "降级", token: "warn", lineStyle: "solid", needsAttention: true },
  down: { health: "down", label: "故障", token: "down", lineStyle: "dashed", needsAttention: true },
  standby: { health: "standby", label: "待命", token: "standby", lineStyle: "dashed", needsAttention: false },
  switching: { health: "switching", label: "切换中", token: "path", lineStyle: "pulse", needsAttention: true },
  unknown: { health: "unknown", label: "未上报", token: "standby", lineStyle: "dashed", needsAttention: true },
};

export function describeNetworkHealth(health: NetworkHealth | null | undefined): NetworkHealthDescriptor {
  return DESCRIPTORS[(health || "unknown") as NetworkHealth] || DESCRIPTORS.unknown;
}

/**
 * 一组状态汇总成一个。
 *
 * 顺序是按「最该先看到哪一个」排的，不是按严重程度排的：
 * 切换中排在故障前面，因为切换是正在发生的事，看到它的人还来得及决定要不要插手；
 * 故障已经发生了，晚看一眼不会更糟。
 *
 * 全空回 unknown —— 不是 healthy。零个成员不代表一切正常，代表什么都不知道。
 */
export function rollUpNetworkHealth(items: readonly (NetworkHealth | null | undefined)[]): NetworkHealth {
  const present = items.filter((item): item is NetworkHealth => !!item && item in DESCRIPTORS);
  if (present.length === 0) return "unknown";
  const order: NetworkHealth[] = ["switching", "down", "degraded", "unknown", "standby", "healthy"];
  for (const candidate of order) {
    if (present.includes(candidate)) return candidate;
  }
  return "unknown";
}

/**
 * 把面板里到处都有的那组原始信号翻译成状态。
 *
 * 参数全部可选，因为不同资源能拿到的信号不一样 —— 主机有 isOnline，隧道有
 * isRunning，规则有探测时间。给不出判断依据时回 unknown。
 */
export function resolveNetworkHealth(signals: {
  /** 明确被停用 / 按设计待命。优先级最高：停用的东西谈不上健康或故障 */
  standby?: boolean;
  /** 正在切换线路 */
  switching?: boolean;
  /** 最近一次探测或心跳是否成功。undefined = 没探过 */
  reachable?: boolean;
  /** 指标越界（延迟偏高、丢包、接近配额） */
  degraded?: boolean;
  /** 最近一次上报距今秒数，超过 staleAfterSeconds 就不算数了 */
  lastSeenAgeSeconds?: number;
  staleAfterSeconds?: number;
}): NetworkHealth {
  if (signals.standby) return "standby";
  if (signals.switching) return "switching";

  const staleAfter = signals.staleAfterSeconds;
  const age = signals.lastSeenAgeSeconds;
  if (typeof staleAfter === "number" && typeof age === "number" && age > staleAfter) {
    // 上报过，但太久了。旧结论不能当新结论用 —— 这正是 unknown 存在的理由。
    return "unknown";
  }

  if (signals.reachable === false) return "down";
  if (signals.reachable === undefined) return "unknown";
  if (signals.degraded) return "degraded";
  return "healthy";
}

/**
 * V1 的三档（online / warning / offline）映射到 V2 的六档。
 *
 * 迁移期用：旧页面还在传三档，新组件只认六档。注意 offline 落到 down 而不是
 * standby —— V1 的 offline 混了「掉线」和「停用」两个意思，掉线是更该被看到的
 * 那个，所以取它。页面迁到 V2 时应该改成直接给出六档之一。
 */
export function fromLegacyTone(tone: "online" | "warning" | "offline" | string): NetworkHealth {
  if (tone === "online") return "healthy";
  if (tone === "warning") return "degraded";
  if (tone === "offline") return "down";
  return "unknown";
}
