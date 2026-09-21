/**
 * 地址分类：一个地址是公网的，还是环回 / 内网 / 链路本地 / 保留 / 组播。
 *
 * 这套判断原来在三个地方各写了一份，而且三份都不一样 —— 30 个样本地址里有
 * **13 个三方判定不一致**：
 *
 *   - `server/ssrf.ts`（插件、迁移等对外请求的 SSRF 守卫）
 *   - `server/routers/lookingGlass.ts`（网络测试，拿用户的 Agent 发探测）
 *   - `server/hostGeo.ts`（要不要去查这个 IP 的归属地）
 *
 * 最要命的一处：**环回写成 `0::1` 或 `0:0:0:0:0:0:0:1` 能绕过 SSRF 守卫**。
 * 那份用的是 `ip === "::1"` 加一串 `startsWith`，换个等价写法就认不出来了。
 * `::ffff:10.0.0.1`（IPv4-mapped，Linux 上连它就是连 10.0.0.1）在网络测试和
 * 归属地那两份里也一路放行。
 *
 * 所以这里只留一份，规则取三份的**并集**，再补上：
 *   - IPv6 先展开成 8 组再按位比，不靠字符串前缀 —— 等价写法一律认得出
 *   - IPv4-mapped 拆出里面的 IPv4 再判
 *
 * **只收紧，不放松。** 有几段（192.0/16、192.2/16、198.51/16、203.0/16）比 RFC
 * 划的保留段宽 —— 原来那三份就是这么写的。这里照旧保留那个宽度：收紧一个安全
 * 守卫是随时能做的事，放松则要有确凿理由，而「让它更贴 RFC」不算理由。
 */

export type IpAddressClass =
  | "public"
  | "loopback"
  | "private"
  | "linkLocal"
  | "multicast"
  | "reserved"
  | "invalid";

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets;
}

/**
 * 把 IPv6 展开成 8 个 16 位组。认不出来返回 null。
 *
 * 结尾的点分四段（`::ffff:127.0.0.1`）先折成两个 16 位组再展开 —— 原来那份
 * 把它替换成 `:0:0`，等于把地址里最关键的部分丢了。
 */
export function expandIpv6(value: string): number[] | null {
  let text = String(value || "").trim().toLowerCase().split("%")[0];
  if (!text) return null;
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);

  const trailingIpv4 = text.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (trailingIpv4) {
    const octets = parseIpv4(trailingIpv4[1]);
    if (!octets) return null;
    const hex = `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
    text = text.slice(0, text.length - trailingIpv4[1].length) + hex;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const groups = halves.length === 1
    ? left
    : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const parsed = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN));
  if (parsed.some((group) => !Number.isInteger(group))) return null;
  return parsed;
}

function classifyIpv4(octets: number[]): IpAddressClass {
  const [a, b] = octets;
  if (a === 0) return "reserved";                                   // 0.0.0.0/8
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private";           // CGNAT 100.64/10
  if (a === 169 && b === 254) return "linkLocal";
  // 下面这几段比 RFC 的保留段宽，是沿用原来三份的写法，见文件头说明
  if (a === 192 && (b === 0 || b === 2 || b === 88)) return "reserved";
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return "reserved";
  if (a === 203 && b === 0) return "reserved";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";                                  // 240/4，含广播地址
  return "public";
}

function classifyIpv6(groups: number[]): IpAddressClass {
  const [first, second] = groups;
  if (groups.every((group) => group === 0)) return "reserved";      // ::
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return "loopback";
  // IPv4-mapped ::ffff:a.b.c.d —— 拆出里面的 IPv4 再判，它是真的会路由过去的
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return classifyIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }
  if ((first & 0xff00) === 0xff00) return "multicast";              // ff00::/8
  if ((first & 0xffc0) === 0xfe80) return "linkLocal";              // fe80::/10
  if ((first & 0xffc0) === 0xfec0) return "reserved";               // fec0::/10，已废弃的站点本地
  if ((first & 0xfe00) === 0xfc00) return "private";                // fc00::/7 ULA
  if (first === 0x2001 && second === 0x0db8) return "reserved";     // 2001:db8::/32 文档用
  return "public";
}

/** 认不出来的一律当 invalid —— 调用方都把 invalid 按「不可用」处理。 */
export function classifyIpAddress(value: string): IpAddressClass {
  const text = String(value || "").trim();
  if (!text) return "invalid";
  const octets = parseIpv4(text);
  if (octets) return classifyIpv4(octets);
  const groups = expandIpv6(text);
  if (groups) return classifyIpv6(groups);
  return "invalid";
}

/** 内网、保留、环回、链路本地、组播，以及认不出来的，都算「不是公网」。 */
export function isPrivateOrReservedAddress(value: string): boolean {
  return classifyIpAddress(value) !== "public";
}

/**
 * 对外请求（SSRF 守卫）能不能连这个地址。
 *
 * `allowPrivate` 只放开内网段（RFC1918、CGNAT），环回和保留段一律不放 ——
 * 「允许内网」的本意是让自建服务能连，不是连回自己。
 *
 * IPv4-mapped 写法一概拒绝，哪怕里面包的是公网地址：没有哪个正经的对外 URL
 * 会写成 `::ffff:8.8.8.8`，而它历来就是绕过滤器的常用花样。原来 ssrf.ts 就是
 * 这么拦的，这里照旧。
 */
export function isRestrictedOutboundAddress(value: string, options: { allowPrivate?: boolean } = {}): boolean {
  const text = String(value || "").trim().toLowerCase();
  const groups = expandIpv6(text);
  if (groups && groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) return true;
  const kind = classifyIpAddress(text);
  if (kind === "public") return false;
  if (kind === "private" && options.allowPrivate === true) return false;
  return true;
}

/**
 * 两个地址字符串指的是不是同一个地址。
 *
 * 大小写和方括号都不算数：`2001:DB8::1`、`2001:db8::1`、`[2001:db8::1]` 是同一个
 * 地址的三种写法。界面一直是这么比的，服务端却是精确字符串相等 —— 6 个样本里
 * 3 个结论不同：界面认为用户选的就是这台主机配好的 IPv6，服务端保存时报
 * 「连接地址只能使用入口地址、已配置的内网IP或IPv6地址」，而它明明就是。
 *
 * 注意这只统一「两个写法是不是同一个地址」，不放宽**哪些地址被允许** ——
 * 允许的仍然只有主机的入口地址、内网 IP 和 IPv6。
 */
export function networkAddressKey(value: unknown) {
  const text = String(value || "").trim();
  const unwrapped = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1).trim() : text;
  return unwrapped.toLowerCase();
}

export function sameNetworkAddress(a: unknown, b: unknown) {
  const left = networkAddressKey(a);
  const right = networkAddressKey(b);
  return !!left && !!right && left === right;
}
