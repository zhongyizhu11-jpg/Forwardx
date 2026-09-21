/**
 * 主备出站的解析、上限与文本语法，全站唯一一份。
 *
 * 原来有两份一模一样的 `parseFailoverTargets`：一份在规则 CRUD（面板存的时候用），
 * 一份在 Agent 心跳（下发给机器的时候用）。而且两份的上限写法不一样 —— CRUD 那份
 * 用 `MAX_FAILOVER_TARGETS`，心跳那份写死 `10`。
 *
 * 今天两个数**碰巧**相等，所以没出事。但这是一次改动就会静默分家的写法：把上限调到
 * 15，面板会收下 15 个目标、Agent 只拿到前 10 个，剩下 5 个不报错、不提示、只是永远
 * 不生效。主备是拿来兜底的，兜底本身悄悄少一半，是最不该发生的那种坏法。
 *
 * 地址的文本语法（界面上那个多行输入框）也挪进来了，原因一样：客户端原来自己写了
 * 一份 `splitFailoverTargetLine`，服务端存的是 JSON —— 两边对「什么算合法」的理解
 * 一旦分家，用户会看到「面板收下了，机器上没生效」。
 */

export const MAX_FAILOVER_TARGETS = 10;

export type FailoverTarget = {
  targetIp: string;
  targetPort: number;
  /**
   * 这条路径的健康探测目标；留空就探出站地址本身。
   *
   * 为什么需要它：Agent 的健康检查是对出站地址做一次 TCP 连接。出站是 iptables/DNAT
   * 类中转时，握手实际是和最终落地完成的，这一次连接就是端到端的；而出站是 gost、
   * realm 这类**用户态**转发时，中转在本地就把连接收下了 —— 连得上只能证明中转活着，
   * 证明不了它到落地那一段还通。
   *
   * 后一种情况下，中转好好的、它的上游断了，主备**不会切**：流量继续往一条死路里送，
   * 而面板上一切正常。填一个能反映整条路径的探测目标（比如中转上另一个直接 DNAT 到
   * 落地的端口），这个盲区才补得上。
   */
  probeIp?: string;
  probePort?: number;
};

export type FailoverEndpoint = { host: string; port: number };

/** IPv6 要带方括号，否则 `::1:80` 分不清哪段是端口。 */
export function formatFailoverEndpoint(host: unknown, port: unknown): string {
  const text = String(host ?? "").trim();
  if (!text) return "";
  return `${text.includes(":") && !text.startsWith("[") ? `[${text}]` : text}:${Math.floor(Number(port) || 0)}`;
}

/** `地址:端口` → `{host, port}`；空串返回 null，格式不对返回 error。 */
export function parseFailoverEndpoint(value: unknown): FailoverEndpoint | { error: string } | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end > 1 && text[end + 1] === ":") {
      return { host: text.slice(1, end).trim(), port: Number(text.slice(end + 2).trim()) };
    }
    return { error: "IPv6 地址请使用 [地址]:端口 格式" };
  }
  const index = text.lastIndexOf(":");
  if (index <= 0 || index === text.length - 1) return { error: "请按 地址:端口 格式填写" };
  return { host: text.slice(0, index).trim(), port: Number(text.slice(index + 1).trim()) };
}

/**
 * 输入框里的一行 → 一个出站。
 *
 * 语法：`地址:端口`，或者 `地址:端口  探测地址:端口`（空白分隔，第二个是选填的
 * 健康探测目标）。多写一个地址就报错，别默默吃掉 —— 吃掉的那一个正是用户以为
 * 已经生效的东西。
 */
export function parseFailoverTargetLine(line: unknown): FailoverTarget | { error: string } | null {
  const parts = String(line ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length > 2) return { error: "一行最多写「出站地址 探测地址」两个地址" };
  const target = parseFailoverEndpoint(parts[0]);
  if (!target) return null;
  if ("error" in target) return target;
  if (parts.length === 1) return { targetIp: target.host, targetPort: target.port };
  const probe = parseFailoverEndpoint(parts[1]);
  if (!probe) return { targetIp: target.host, targetPort: target.port };
  if ("error" in probe) return { error: `探测地址：${probe.error}` };
  return { targetIp: target.host, targetPort: target.port, probeIp: probe.host, probePort: probe.port };
}

/** 一个出站 → 输入框里的一行。和 parseFailoverTargetLine 互为反函数。 */
export function formatFailoverTargetLine(target: FailoverTarget): string {
  const main = formatFailoverEndpoint(target.targetIp, target.targetPort);
  const probe = target.probeIp ? formatFailoverEndpoint(target.probeIp, target.probePort) : "";
  return probe ? `${main} ${probe}` : main;
}

/** 这条出站实际该探哪儿：填了探测目标就探它，没填就探出站地址本身。 */
export function failoverProbeEndpoint(target: FailoverTarget): FailoverEndpoint {
  const host = String(target.probeIp || "").trim();
  const port = Math.floor(Number(target.probePort) || 0);
  if (host && port >= 1 && port <= 65535) return { host, port };
  return { host: target.targetIp, port: target.targetPort };
}

function sanitizeTarget(raw: any): FailoverTarget | null {
  const targetIp = String(raw?.targetIp || "").trim();
  const targetPort = Number(raw?.targetPort);
  if (!targetIp || !(targetPort >= 1 && targetPort <= 65535)) return null;
  const probeIp = String(raw?.probeIp || "").trim();
  const probePort = Number(raw?.probePort);
  return probeIp && probePort >= 1 && probePort <= 65535
    ? { targetIp, targetPort, probeIp, probePort }
    : { targetIp, targetPort };
}

export function parseFailoverTargets(raw: unknown): FailoverTarget[] {
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(sanitizeTarget)
      .filter((target): target is FailoverTarget => !!target)
      .slice(0, MAX_FAILOVER_TARGETS);
  } catch {
    return [];
  }
}
