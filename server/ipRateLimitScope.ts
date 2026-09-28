import net from "node:net";

/**
 * 限流用的「来源」键。
 *
 * IPv4 按单个地址；IPv6 按 /64 归并 —— 一个用户通常拿到的就是一整段 /64，按单个地址
 * 计数的话，换个地址就是一份新的失败额度，限流形同虚设。IPv4 映射地址（::ffff:a.b.c.d）
 * 按它的 IPv4 算。认不出来的原样小写返回。
 */
export function ipRateLimitScope(ip: string) {
  const raw = String(ip || "unknown").trim().toLowerCase() || "unknown";
  const mapped = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  if (net.isIPv6(raw.split("%")[0])) {
    return `${expandIpv6(raw.split("%")[0]).slice(0, 4).join(":")}::/64`;
  }
  return raw;
}

function expandIpv6(address: string): string[] {
  let text = address;
  // 末尾嵌着 IPv4 的写法（如 64:ff9b::1.2.3.4）先换成两组十六进制。
  const v4 = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const parts = v4[1].split(".").map((part) => Number(part));
    text = text.slice(0, -v4[1].length)
      + ((parts[0] << 8) | parts[1]).toString(16) + ":" + ((parts[2] << 8) | parts[3]).toString(16);
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, null];
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = tail === null ? 0 : 8 - headParts.length - tailParts.length;
  return [...headParts, ...Array(Math.max(0, missing)).fill("0"), ...tailParts]
    .map((part) => (part || "0").replace(/^0+(?=.)/, ""));
}
