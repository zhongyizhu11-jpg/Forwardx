/**
 * 备用出站那几行文本，究竟指向哪儿。
 *
 * 主备的备用出站是一个多行文本框，每行一个 `地址:端口`。面板里其实认得这些地址 ——
 * 它们多半就是某台中转上的一条转发规则。认出来之后能当场说清三件手填时永远看不见
 * 的事：
 *
 *   1. **这条出站是哪台中转的哪条规则**。手填的地址过两个月自己都不记得是什么。
 *   2. **它的健康检查有没有盲区**。中转用 iptables/nftables 时，探测这个端口的
 *      TCP 握手是和最终落地完成的，端到端；用 gost/realm/socat/nginx 时，中转在
 *      用户态就把连接收下了 —— 连得上只证明中转活着，它到落地那段断了照样探不出来，
 *      主备不会切，流量继续往死路里送。这种时候得另配一个探测目标。
 *   3. **它和主出站是不是通向同一个落地**。主备的前提就是「两条路通到同一个地方」，
 *      指错了的话切过去等于换了个服务，而这件事只有真出事那天才会暴露。
 *
 * 判断放在纯函数里：界面渲染不了的东西测不了，而这三条恰恰是最该测的。
 */

export type RelayCandidate = {
  id: number;
  label: string;
  hostName: string;
  /** 这条中转对外的入口地址，`地址:端口`。 */
  address: string;
  forwardType: string;
  /** 用户态转发（探测只到中转本身）。 */
  userspaceRelay: boolean;
  /** 这条中转自己指向哪儿。 */
  targetIp: string;
  targetPort: number;
};

export type FailoverLineHint = {
  /** 第几行，从 1 开始，和输入框里看到的一致。 */
  line: number;
  address: string;
  /** 认出来是面板里的哪条中转；手填的外部地址是 null。 */
  relay: RelayCandidate | null;
  /** 填了探测目标。 */
  hasProbe: boolean;
  /** 用户态中转又没配探测目标 —— 这条出站的健康检查有盲区。 */
  probeBlindSpot: boolean;
  /** 和主出站通向同一个落地；认不出中转时无从判断，为 null。 */
  sameDestination: boolean | null;
};

function normalizeAddress(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function destinationOf(candidate: RelayCandidate): string {
  return `${normalizeAddress(candidate.targetIp)}:${Math.floor(Number(candidate.targetPort) || 0)}`;
}

/**
 * 主出站最终通向哪儿。
 *
 * 主出站自己也可能是一台中转 —— 用户要的正是「主走中转 A、备走中转 C，两条都到同一个
 * 落地」。所以先看它认不认得出是某条中转，认得出就比中转指向的落地，认不出才按字面
 * 地址比。只穿一层：多层链路上的最终落地得顺着链子走，那是后面线路组的事。
 */
function resolveDestination(address: string, byAddress: Map<string, RelayCandidate>): string {
  const relay = byAddress.get(normalizeAddress(address));
  return relay ? destinationOf(relay) : normalizeAddress(address);
}

export function describeFailoverLines(input: {
  /** 备用出站输入框的原文。 */
  text: string;
  candidates: RelayCandidate[];
  /** 主出站的地址与端口。 */
  mainAddress: string;
  parseLine: (line: string) => { targetIp: string; targetPort: number; probeIp?: string; probePort?: number } | { error: string } | null;
  formatEndpoint: (host: unknown, port: unknown) => string;
}): FailoverLineHint[] {
  const byAddress = new Map<string, RelayCandidate>();
  for (const candidate of input.candidates) {
    const key = normalizeAddress(candidate.address);
    if (key && !byAddress.has(key)) byAddress.set(key, candidate);
  }
  const mainDestination = resolveDestination(input.mainAddress, byAddress);

  const hints: FailoverLineHint[] = [];
  const lines = String(input.text || "").split(/\r?\n/);
  lines.forEach((raw, index) => {
    if (!raw.trim()) return;
    const parsed = input.parseLine(raw);
    if (!parsed || "error" in parsed) return;
    const address = input.formatEndpoint(parsed.targetIp, parsed.targetPort);
    const relay = byAddress.get(normalizeAddress(address)) || null;
    const hasProbe = !!parsed.probeIp && Number(parsed.probePort) > 0;
    hints.push({
      line: index + 1,
      address,
      relay,
      hasProbe,
      probeBlindSpot: !!relay && relay.userspaceRelay && !hasProbe,
      sameDestination: relay && mainDestination
        ? destinationOf(relay) === mainDestination
        : null,
    });
  });
  return hints;
}

/** 一行提示的文字。没有可说的就返回空串 —— 不要为了整齐而说废话。 */
export function failoverLineHintText(hint: FailoverLineHint): string {
  const parts: string[] = [];
  if (hint.relay) parts.push(`${hint.relay.hostName} · ${hint.relay.label}`);
  if (hint.probeBlindSpot) {
    parts.push(`${hint.relay?.forwardType} 是用户态转发，探测只能确认中转在线，建议补一个探测目标`);
  }
  if (hint.sameDestination === false) {
    parts.push(`通向 ${hint.relay?.targetIp}:${hint.relay?.targetPort}，和主出站不是同一个落地`);
  }
  return parts.join(" · ");
}
