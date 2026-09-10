/**
 * 各客户端的一键导入链接。
 *
 * 每个 scheme 都核对过官方来源（Loon 与 Quantumult X 是官方仓库文档，sing-box
 * 是官方手册，其余是各自客户端长期通行的写法），没有凭印象写：点了没反应的按钮
 * 比没有按钮更糟，用户会以为是订阅坏了。
 */

import {
  PROXY_SUBSCRIPTION_FORMAT_LABELS,
  type ProxySubscriptionFormat,
} from "./proxySubscription";
import { encodeBase64Utf8 } from "./proxyNode";

/**
 * 一键导入走的是 deep link，只有装了该客户端的设备点得动 —— 在 Windows 上点
 * loon:// 是个什么都不会发生的死按钮。所以平台不是展示信息，而是筛选依据。
 * 跨设备导入靠二维码，不靠这些图标。
 */
export const PROXY_CLIENT_PLATFORMS = ["ios", "android", "windows", "macos", "linux"] as const;

export type ProxyClientPlatform = (typeof PROXY_CLIENT_PLATFORMS)[number];

export const PROXY_CLIENT_PLATFORM_LABELS: Record<ProxyClientPlatform, string> = {
  ios: "iOS",
  android: "Android",
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

export type ProxyClientTarget = {
  id: string;
  /** 客户端显示名 */
  label: string;
  /** 窄屏用的短名：三列网格放不下"Quantumult X"这种长名 */
  shortLabel: string;
  /** 支持该客户端的平台，用于按当前设备筛选 */
  platforms: readonly ProxyClientPlatform[];
  /**
   * 同一个 scheme 还覆盖哪些客户端。
   *
   * 一格 clash:// 管着整个 Clash 家族，界面上只写"Clash"会让用 Clash Verge 的人
   * 以为没有自己那个，所以把名字列出来。
   */
  covers?: string;
  /** 该客户端要拉的订阅格式 */
  format: ProxySubscriptionFormat;
  /** 由订阅地址和名称拼出可点击的 scheme */
  buildImportUrl: (subscriptionUrl: string, name: string) => string;
};

const ALL_PLATFORMS = PROXY_CLIENT_PLATFORMS;

/** base64url，去掉补位的等号：Shadowrocket 的 sub:// 用的是这种。 */
function base64UrlOfText(value: string): string {
  return encodeBase64Utf8(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 订阅地址里带 ?format=...&rules=... 这种查询串，塞进另一个 URL 的参数时
 * 必须整体百分号编码，否则 & 会被外层当成参数分隔符而截断。
 */
function q(value: string): string {
  return encodeURIComponent(value);
}

export const PROXY_CLIENT_TARGETS: readonly ProxyClientTarget[] = [
  {
    id: "clash",
    label: "Clash / mihomo",
    shortLabel: "Clash",
    platforms: ALL_PLATFORMS,
    // 这些都注册 clash:// install-config，一格全覆盖。
    covers: "Clash Verge Rev、ClashX、ClashX Meta、FlClash、Clash for Android、Clash Meta",
    format: "clash",
    buildImportUrl: (url, name) => `clash://install-config?url=${q(url)}&name=${q(name)}`,
  },
  {
    id: "stash",
    label: "Stash",
    shortLabel: "Stash",
    platforms: ["ios", "macos"],
    format: "clash",
    buildImportUrl: (url, name) => `stash://install-config?url=${q(url)}&name=${q(name)}`,
  },
  {
    id: "singbox",
    label: "sing-box",
    shortLabel: "sing-box",
    platforms: ALL_PLATFORMS,
    format: "singbox",
    // 名称走 fragment，不是查询参数。
    buildImportUrl: (url, name) => `sing-box://import-remote-profile?url=${q(url)}#${q(name)}`,
  },
  {
    id: "loon",
    label: "Loon",
    shortLabel: "Loon",
    platforms: ["ios"],
    format: "loon",
    buildImportUrl: (url, name) => `loon://import?sub=${q(url)}&name=${q(name)}`,
  },
  {
    id: "surge",
    label: "Surge",
    shortLabel: "Surge",
    // surge:///install-config 是 Surge 的 iOS/macOS 专属。安卓上的 Surfboard 虽然
    // 读同一套配置格式（订阅按 UA 给它 Surge 格式），但只有自己的导入界面、
    // 不认这个 scheme —— 列进 android 就是在安卓上摆一个点了没反应的按钮。
    platforms: ["ios", "macos"],
    covers: "Surfboard（安卓，需手动粘贴地址）",
    format: "surge",
    // surge 后面是三条斜杠，少一条不会被识别。
    buildImportUrl: (url) => `surge:///install-config?url=${q(url)}`,
  },
  {
    id: "quantumultx",
    label: "Quantumult X",
    shortLabel: "QuantumultX",
    platforms: ["ios"],
    format: "quantumultx",
    // add-resource 会保留已有资源，update-configuration 则会覆盖，这里取前者。
    buildImportUrl: (url, name) => {
      const payload = JSON.stringify({ server_remote: [`${url}, tag=${name}`] });
      return `quantumult-x:///add-resource?remote-resource=${q(payload)}`;
    },
  },
  {
    id: "hiddify",
    label: "Hiddify",
    shortLabel: "Hiddify",
    platforms: ALL_PLATFORMS,
    // Hiddify 明确支持 v2ray sublink（也就是通用 base64），走这条最稳。
    format: "base64",
    // 官方 wiki 的当前写法是 hiddify://import/<sublink>#name，订阅地址放在路径里
    // 而不是查询参数；install-config?url= 那套已被标记为不推荐。
    buildImportUrl: (url, name) => `hiddify://import/${url}#${q(name)}`,
  },
  {
    id: "shadowrocket",
    label: "Shadowrocket",
    shortLabel: "Shadowrocket",
    platforms: ["ios"],
    format: "base64",
    // sub:// 后面直接跟订阅地址的 base64，不是查询参数。
    buildImportUrl: (url, name) => `sub://${base64UrlOfText(url)}#${q(name)}`,
  },
];

export function proxyClientTargetsForFormat(format: ProxySubscriptionFormat): ProxyClientTarget[] {
  return PROXY_CLIENT_TARGETS.filter((target) => target.format === format);
}

/** 图标下方那行小字。全平台就写"全平台"，否则逐个列出来。 */
export function proxyClientPlatformsLabel(target: ProxyClientTarget): string {
  if (target.platforms.length >= PROXY_CLIENT_PLATFORMS.length) return "全平台";
  return target.platforms.map((item) => PROXY_CLIENT_PLATFORM_LABELS[item]).join(" / ");
}

export function proxyClientTargetsForPlatform(platform: ProxyClientPlatform): ProxyClientTarget[] {
  return PROXY_CLIENT_TARGETS.filter((target) => target.platforms.includes(platform));
}

/**
 * 从 UA 认出当前设备。
 *
 * iPadOS 13 起 Safari 的 UA 伪装成 "Macintosh; Intel Mac OS X"，跟桌面 Mac 一模一样，
 * 只能靠触摸点数区分 —— 认错的代价是 iPad 上少了 Loon、Shadowrocket 这些只有 iOS 才有的，
 * 所以宁可让调用方把触摸信息传进来。
 */
export function detectProxyClientPlatform(
  userAgent: string,
  options?: { maxTouchPoints?: number },
): ProxyClientPlatform | null {
  const ua = String(userAgent || "");
  if (!ua) return null;

  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Macintosh|Mac OS X/i.test(ua)) {
    // 伪装成 Mac 的 iPad：桌面 Mac 的触摸点数是 0。
    return (options?.maxTouchPoints ?? 0) > 1 ? "ios" : "macos";
  }
  if (/Windows/i.test(ua)) return "windows";
  if (/Linux|X11|CrOS/i.test(ua)) return "linux";
  return null;
}

// ==================== 订阅种类 ====================

export const PROXY_SUBSCRIPTION_KINDS = ["nodes", "rules"] as const;

export type ProxySubscriptionKind = (typeof PROXY_SUBSCRIPTION_KINDS)[number];

export const PROXY_SUBSCRIPTION_KIND_LABELS: Record<ProxySubscriptionKind, string> = {
  nodes: "节点订阅",
  rules: "规则订阅",
};

export const PROXY_SUBSCRIPTION_KIND_HINTS: Record<ProxySubscriptionKind, string> = {
  nodes: "只有节点，分流规则由你在客户端里自己配。所有客户端都适用。",
  rules: "连分流规则一起给，导入后不用再设置。仅 Clash 与 sing-box 能表达规则。",
};

/**
 * 拼订阅地址。
 *
 * 节点订阅不带 rules 参数，规则订阅带上 —— 这样同一个令牌就能同时提供两种，
 * 不必为了换一种而重新签发地址。
 */
export function buildProxySubscriptionUrl(options: {
  origin: string;
  token: string;
  format: ProxySubscriptionFormat;
  kind: ProxySubscriptionKind;
}): string {
  const params = new URLSearchParams();
  // 通用 base64 不带 format，方便直接粘进只认裸地址的老客户端。
  if (options.format !== "base64") params.set("format", options.format);
  // rules=1 表示按订阅链接上配置的预设来，具体档位不暴露在地址里。
  if (options.kind === "rules") params.set("rules", "1");
  const query = params.toString();
  return `${options.origin.replace(/\/+$/, "")}/api/sub/${options.token}${query ? `?${query}` : ""}`;
}

/** 该格式是否真的能表达分流规则；不能的话没必要展示规则订阅地址。 */
export function proxySubscriptionKindSupported(
  format: ProxySubscriptionFormat,
  kind: ProxySubscriptionKind,
): boolean {
  if (kind === "nodes") return true;
  return format === "clash" || format === "singbox";
}

export function proxySubscriptionFormatLabel(format: ProxySubscriptionFormat): string {
  return PROXY_SUBSCRIPTION_FORMAT_LABELS[format];
}
