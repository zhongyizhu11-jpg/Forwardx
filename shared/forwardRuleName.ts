/**
 * 没填名字的转发，叫什么。
 *
 * 名字这个字段原来是必填的，但它既不影响转发怎么走，也不影响流量算在谁头上 ——
 * 纯粹是列表和搜索里用来认人的。为了它拦住「填完端口和目标就能保存」这件事，
 * 不值得。
 *
 * 所以留空时由面板兜底生成。生成规则只有一条原则：**让人在列表里一眼认出这是哪条**。
 * 目标地址最能说明「这条转发是干嘛的」（用户自己起名多半也是照着目标起的），
 * 所以优先用目标；连目标都没有时退到源端口。
 */
export function autoForwardRuleName(input: {
  targetIp?: unknown;
  targetPort?: unknown;
  sourcePort?: unknown;
}): string {
  const host = String(input.targetIp ?? "").trim();
  const targetPort = Number(input.targetPort ?? 0);
  if (host) {
    // IPv6 要带方括号，否则 `::1:80` 分不清哪段是端口。
    const shown = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    return targetPort > 0 ? `${shown}:${targetPort}` : shown;
  }
  const sourcePort = Number(input.sourcePort ?? 0);
  // 源端口 0 表示「由面板随机分配」，这时候还没有号可用。
  if (sourcePort > 0) return `转发 ${sourcePort}`;
  return "未命名转发";
}

/** 用户填了就用用户的，没填才兜底。只有空白字符也算没填。 */
export function resolveForwardRuleName(
  name: unknown,
  fallbackFrom: Parameters<typeof autoForwardRuleName>[0],
): string {
  const trimmed = String(name ?? "").trim();
  return trimmed || autoForwardRuleName(fallbackFrom);
}
