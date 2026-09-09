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

export type ProxyClientTarget = {
  id: string;
  /** 客户端显示名 */
  label: string;
  /** 该客户端要拉的订阅格式 */
  format: ProxySubscriptionFormat;
  /** 由订阅地址和名称拼出可点击的 scheme */
  buildImportUrl: (subscriptionUrl: string, name: string) => string;
};

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
    format: "clash",
    buildImportUrl: (url, name) => `clash://install-config?url=${q(url)}&name=${q(name)}`,
  },
  {
    id: "stash",
    label: "Stash",
    format: "clash",
    buildImportUrl: (url, name) => `stash://install-config?url=${q(url)}&name=${q(name)}`,
  },
  {
    id: "singbox",
    label: "sing-box",
    format: "singbox",
    // 名称走 fragment，不是查询参数。
    buildImportUrl: (url, name) => `sing-box://import-remote-profile?url=${q(url)}#${q(name)}`,
  },
  {
    id: "loon",
    label: "Loon",
    format: "loon",
    buildImportUrl: (url, name) => `loon://import?sub=${q(url)}&name=${q(name)}`,
  },
  {
    id: "surge",
    label: "Surge / Surfboard",
    format: "surge",
    // surge 后面是三条斜杠，少一条不会被识别。
    buildImportUrl: (url) => `surge:///install-config?url=${q(url)}`,
  },
  {
    id: "quantumultx",
    label: "Quantumult X",
    format: "quantumultx",
    // add-resource 会保留已有资源，update-configuration 则会覆盖，这里取前者。
    buildImportUrl: (url, name) => {
      const payload = JSON.stringify({ server_remote: [`${url}, tag=${name}`] });
      return `quantumult-x:///add-resource?remote-resource=${q(payload)}`;
    },
  },
  {
    id: "shadowrocket",
    label: "Shadowrocket",
    format: "base64",
    // sub:// 后面直接跟订阅地址的 base64，不是查询参数。
    buildImportUrl: (url, name) => `sub://${base64UrlOfText(url)}#${q(name)}`,
  },
];

export function proxyClientTargetsForFormat(format: ProxySubscriptionFormat): ProxyClientTarget[] {
  return PROXY_CLIENT_TARGETS.filter((target) => target.format === format);
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
