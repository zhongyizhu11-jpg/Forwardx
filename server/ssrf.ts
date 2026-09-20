import { isRestrictedOutboundAddress } from "../shared/ipAddress";
import { lookup } from "dns/promises";
import { isIP } from "net";

type SafeOutboundOptions = {
  allowPrivate?: boolean;
  purpose?: string;
};

function blockedHostError(purpose: string, host: string) {
  return new Error(`${purpose} 不允许访问受限地址 ${host}`);
}

function normalizeHost(host: string) {
  return String(host || "").trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function isRestrictedIp(value: string, allowPrivate: boolean) {
  return isRestrictedOutboundAddress(value, { allowPrivate });
}

export async function assertSafeOutboundHost(rawHost: string, options: SafeOutboundOptions = {}) {
  const purpose = options.purpose || "此请求";
  const host = normalizeHost(rawHost);
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw blockedHostError(purpose, host || "-");
  }
  const allowPrivate = options.allowPrivate === true;
  if (isIP(host)) {
    if (isRestrictedIp(host, allowPrivate)) throw blockedHostError(purpose, host);
    return;
  }
  let records: Array<{ address: string }>;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`${purpose} 无法解析目标地址 ${host}`);
  }
  if (records.length === 0 || records.some((record) => isRestrictedIp(record.address, allowPrivate))) {
    throw blockedHostError(purpose, host);
  }
}

export async function assertSafeOutboundUrl(rawUrl: string, options: SafeOutboundOptions = {}) {
  let url: URL;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error(`${options.purpose || "此请求"} 地址无效`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${options.purpose || "此请求"} 仅支持 HTTP/HTTPS 地址`);
  }
  if (url.username || url.password) {
    throw new Error(`${options.purpose || "此请求"} 不允许 URL 内嵌账号信息`);
  }
  await assertSafeOutboundHost(url.hostname, options);
  return url;
}

export async function assertSafePluginHttpUrl(rawUrl: string) {
  const allowPrivate = /^(1|true|yes|on)$/i.test(String(process.env.FORWARDX_ALLOW_PRIVATE_PLUGIN_HTTP || ""));
  return assertSafeOutboundUrl(rawUrl, { allowPrivate, purpose: "插件 HTTP 请求" });
}
