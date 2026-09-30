import { isPrivateOrReservedAddress } from "../shared/ipAddress";
import dns from "node:dns/promises";
import net from "node:net";
import * as db from "./db";
import { executeRaw, queryRaw } from "./dbRuntime";
import { quoteIdentifier } from "./dbCompat";

const GEO_REQUEST_TIMEOUT_MS = 8000;
const ADDRESS_GEO_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const ADDRESS_GEO_STALE_MS = 30 * 24 * 60 * 60 * 1000;
const GEO_REFRESH_INTERVAL_MS = ADDRESS_GEO_FRESH_MS;
const ADDRESS_GEO_NEGATIVE_CACHE_MS = 30 * 60 * 1000;
const MAX_ADDRESS_GEO_CACHE_ENTRIES = 4096;
/*
  没定到位的主机按指数退避重试：10 分钟起，每失败一次翻倍，封顶 6 小时。
  以前只在有人翻主机列表时才试一次，ipapi.co 限流那阵子空着的机器就一直空着；
  但也不能每次翻列表都打一次 —— 那正是把免费额度打光的原因。
*/
const GEO_RETRY_BASE_MS = 10 * 60 * 1000;
const GEO_RETRY_MAX_MS = 6 * 60 * 60 * 1000;

const refreshingHostIds = new Set<number>();
const addressGeoCache = new Map<string, AddressGeoCacheEntry>();
const addressGeoInflight = new Map<string, Promise<AddressGeoLookupResult | null>>();
const hostGeoRetryState = new Map<number, { attempts: number; notBefore: number }>();

type ProviderGeo = {
  geoCountryCode: string;
  geoCountryName: string | null;
  geoRegion: string | null;
  geoEmoji: string | null;
  geoLatitudeMicro: number | null;
  geoLongitudeMicro: number | null;
  geoUpdatedAt: Date;
  provider: string;
};

type GeoProvider = {
  name: string;
  url: (address: string) => string;
  /** 429 之后歇多久。各家额度不同：ipapi.co 按天，ip-api.com 按分钟。 */
  cooldownMs: number;
  /** 把响应翻译成统一字段；返回 { rateLimited: true } 表示这是配额问题而不是查不到 */
  parse: (data: any) => Omit<ProviderGeo, "geoUpdatedAt" | "provider"> | { rateLimited: true } | null;
  rateLimitedUntil: number;
};

function nonEmpty(value: unknown) {
  return String(value ?? "").trim() || null;
}

/*
  三家免费服务按顺序兜底。任何一家查不到、超时、限流，就换下一家；限流状态
  各记各的 —— ipapi.co 被打满不代表 ip-api.com 也不能用，以前一个全局标记
  把三家一起判死刑，机器就只能等一小时。
  ip-api.com 免费档只走 http（https 要付费），查的是公网 IP 的归属地，不带
  任何凭据，明文也无妨。
*/
const GEO_PROVIDERS: GeoProvider[] = [
  {
    name: "ipapi.co",
    url: (address) => `https://ipapi.co/${encodeURIComponent(address)}/json/`,
    cooldownMs: 60 * 60 * 1000,
    rateLimitedUntil: 0,
    parse: (data) => {
      if (data?.error) {
        return /rate|quota|limit/i.test(String(data.reason || data.message || "")) ? { rateLimited: true } : null;
      }
      const countryCode = String(data?.country_code || "").trim().toUpperCase();
      if (!countryCode) return null;
      return {
        geoCountryCode: countryCode,
        geoCountryName: nonEmpty(data.country_name),
        geoRegion: nonEmpty(data.region) || nonEmpty(data.city),
        geoEmoji: nonEmpty(data.emoji) || countryCodeToEmoji(countryCode) || null,
        geoLatitudeMicro: toCoordinateMicro(data.latitude),
        geoLongitudeMicro: toCoordinateMicro(data.longitude),
      };
    },
  },
  {
    name: "ip-api.com",
    url: (address) => `http://ip-api.com/json/${encodeURIComponent(address)}?fields=status,message,country,countryCode,regionName,city,lat,lon`,
    cooldownMs: 2 * 60 * 1000,
    rateLimitedUntil: 0,
    parse: (data) => {
      if (String(data?.status || "") !== "success") {
        return /quota|limit|too many/i.test(String(data?.message || "")) ? { rateLimited: true } : null;
      }
      const countryCode = String(data.countryCode || "").trim().toUpperCase();
      if (!countryCode) return null;
      return {
        geoCountryCode: countryCode,
        geoCountryName: nonEmpty(data.country),
        geoRegion: nonEmpty(data.regionName) || nonEmpty(data.city),
        geoEmoji: countryCodeToEmoji(countryCode) || null,
        geoLatitudeMicro: toCoordinateMicro(data.lat),
        geoLongitudeMicro: toCoordinateMicro(data.lon),
      };
    },
  },
  {
    name: "ipwho.is",
    url: (address) => `https://ipwho.is/${encodeURIComponent(address)}`,
    cooldownMs: 60 * 60 * 1000,
    rateLimitedUntil: 0,
    parse: (data) => {
      if (data?.success === false) {
        return /quota|limit|too many/i.test(String(data.message || "")) ? { rateLimited: true } : null;
      }
      const countryCode = String(data?.country_code || "").trim().toUpperCase();
      if (!countryCode) return null;
      return {
        geoCountryCode: countryCode,
        geoCountryName: nonEmpty(data.country),
        geoRegion: nonEmpty(data.region) || nonEmpty(data.city),
        geoEmoji: nonEmpty(data.flag?.emoji) || countryCodeToEmoji(countryCode) || null,
        geoLatitudeMicro: toCoordinateMicro(data.latitude),
        geoLongitudeMicro: toCoordinateMicro(data.longitude),
      };
    },
  },
];

function allGeoProvidersRateLimited(now = Date.now()) {
  return GEO_PROVIDERS.every((provider) => provider.rateLimitedUntil > now);
}

/** 测试用：看各家的限流状态 */
export function getGeoProviderStates() {
  return GEO_PROVIDERS.map((provider) => ({ name: provider.name, rateLimitedUntil: provider.rateLimitedUntil }));
}

/** 测试用：把内存里的缓存、限流、退避全部清掉 */
export function resetHostGeoStateForTests() {
  for (const provider of GEO_PROVIDERS) provider.rateLimitedUntil = 0;
  addressGeoCache.clear();
  addressGeoInflight.clear();
  hostGeoRetryState.clear();
  refreshingHostIds.clear();
}

type AddressGeoCacheEntry = {
  freshUntil: number;
  expiresAt: number;
  value: AddressGeoLookupResult | null;
};

function setAddressGeoCache(key: string, entry: AddressGeoCacheEntry) {
  addressGeoCache.delete(key);
  addressGeoCache.set(key, entry);
  while (addressGeoCache.size > MAX_ADDRESS_GEO_CACHE_ENTRIES) {
    const oldest = addressGeoCache.keys().next().value;
    if (!oldest) break;
    addressGeoCache.delete(oldest);
  }
}

export type AddressGeoLookupResult = {
  address: string;
  resolvedAddress: string;
  geoCountryCode: string;
  geoCountryName: string | null;
  geoRegion: string | null;
  geoEmoji: string | null;
  geoLatitudeMicro: number | null;
  geoLongitudeMicro: number | null;
  geoUpdatedAt: Date;
  /** 哪家服务给的答案；从旧缓存行读出来时可能为空 */
  provider?: string | null;
};

function countryCodeToEmoji(countryCode: string | null | undefined) {
  const code = String(countryCode || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "";
  return Array.from(code)
    .map((char) => String.fromCodePoint(0x1f1e6 + char.charCodeAt(0) - 65))
    .join("");
}

function toTime(value: unknown) {
  if (!value) return 0;
  const time = new Date(value as any).getTime();
  return Number.isFinite(time) ? time : 0;
}

function toCoordinateMicro(value: unknown) {
  if (value == null || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 1_000_000);
}

function epochSeconds(value = new Date()) {
  return Math.floor(value.getTime() / 1000);
}

function rowDate(value: unknown) {
  if (value instanceof Date) return value;
  const num = Number(value || 0);
  if (Number.isFinite(num) && num > 0) return new Date(num * 1000);
  const parsed = new Date(value as any);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function cacheResultFromRow(row: any): AddressGeoLookupResult | null {
  const countryCode = String(row?.geoCountryCode || "").trim().toUpperCase();
  const resolvedAddress = String(row?.resolvedAddress || "").trim();
  const address = String(row?.address || resolvedAddress || "").trim();
  if (!countryCode || !resolvedAddress || !address) return null;
  return {
    address,
    resolvedAddress,
    geoCountryCode: countryCode,
    geoCountryName: String(row?.geoCountryName || "").trim() || null,
    geoRegion: String(row?.geoRegion || "").trim() || null,
    geoEmoji: String(row?.geoEmoji || "").trim() || countryCodeToEmoji(countryCode) || null,
    geoLatitudeMicro: row?.geoLatitudeMicro == null ? null : Number(row.geoLatitudeMicro),
    geoLongitudeMicro: row?.geoLongitudeMicro == null ? null : Number(row.geoLongitudeMicro),
    geoUpdatedAt: rowDate(row?.fetchedAt || row?.geoUpdatedAt),
    provider: nonEmpty(row?.provider),
  };
}

function isHostUnlocated(host: any) {
  if (!host?.geoCountryCode && !host?.geoCountryName && !host?.geoEmoji) return true;
  return host?.geoLatitudeMicro == null || host?.geoLongitudeMicro == null;
}

function isRefreshDue(host: any) {
  // 手动指定的位置由用户说了算，自动定位不看也不写。
  if (host?.geoManual) return false;
  const hostId = Number(host?.id) || 0;
  const retry = hostId ? hostGeoRetryState.get(hostId) : undefined;
  if (retry && retry.notBefore > Date.now()) return false;
  if (isHostUnlocated(host)) return true;
  const updatedAt = toTime(host?.geoUpdatedAt);
  return !updatedAt || Date.now() - updatedAt >= GEO_REFRESH_INTERVAL_MS;
}

function noteHostGeoFailure(hostId: number) {
  const previous = hostGeoRetryState.get(hostId);
  const attempts = (previous?.attempts || 0) + 1;
  const delay = Math.min(GEO_RETRY_MAX_MS, GEO_RETRY_BASE_MS * 2 ** (attempts - 1));
  hostGeoRetryState.set(hostId, { attempts, notBefore: Date.now() + delay });
  return delay;
}

/** 测试用：某台主机下次自动定位最早什么时候 */
export function getHostGeoRetryState(hostId: number) {
  return hostGeoRetryState.get(hostId) || null;
}

function pickLookupAddress(host: any) {
  const candidates = [host?.ipv4, host?.ipv6, host?.ip, host?.entryIp];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (!value || value.toLowerCase() === "unknown") continue;
    return value;
  }
  return "";
}

function isIpAddress(value: string) {
  return net.isIP(normalizeLookupAddress(value)) !== 0;
}

function normalizeLookupAddress(value: string) {
  const trimmed = String(value || "").trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1).trim();
  return trimmed;
}

function isPrivateAddress(address: string) {
  const normalized = normalizeLookupAddress(address);
  /*
    不是 IP 就不拦。这里两个调用方传进来的都已经是解析后的地址；万一不是，
    交给后面的解析流程去处理，而不是在这里当成内网 —— 这是原来的行为，保留。
  */
  if (!net.isIP(normalized)) return false;
  return isPrivateOrReservedAddress(normalized);
}

async function resolveLookupAddress(address: string) {
  const normalized = normalizeLookupAddress(address);
  if (isIpAddress(normalized)) return normalized;
  const results = await dns.lookup(normalized, { all: true, family: 0, verbatim: false });
  const publicResult = results.find((result) => !isPrivateAddress(result.address));
  return (publicResult || results[0])?.address || normalized;
}

async function fetchFromGeoProvider(provider: GeoProvider, address: string): Promise<ProviderGeo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEO_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(provider.url(address), {
      cache: "no-store",
      headers: { Accept: "application/json", "User-Agent": "ForwardX" },
      signal: controller.signal,
    });
    if (res.status === 429) {
      provider.rateLimitedUntil = Date.now() + provider.cooldownMs;
      throw new Error(`${provider.name} 429 rate limited`);
    }
    if (!res.ok) throw new Error(`${provider.name} HTTP ${res.status}`);
    const data = await res.json() as any;
    const parsed = provider.parse(data);
    if (!parsed) throw new Error(`${provider.name} empty response`);
    if ("rateLimited" in parsed) {
      provider.rateLimitedUntil = Date.now() + provider.cooldownMs;
      throw new Error(`${provider.name} quota exceeded`);
    }
    return { ...parsed, geoUpdatedAt: new Date(), provider: provider.name };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 按顺序问三家服务，第一家答上来就用。
 *
 * 限流中的跳过；查不到坐标（有国家没经纬度）也算没答上，换下一家 —— 地图
 * 要的是点，光有国家画不出来。全部失败时把每家的原因串起来抛出去，日志里
 * 一眼能看出是哪家在闹。
 */
export async function fetchHostGeo(address: string): Promise<ProviderGeo> {
  const errors: string[] = [];
  const now = Date.now();
  for (const provider of GEO_PROVIDERS) {
    if (provider.rateLimitedUntil > now) {
      errors.push(`${provider.name} rate limited until ${new Date(provider.rateLimitedUntil).toISOString()}`);
      continue;
    }
    try {
      const geo = await fetchFromGeoProvider(provider, address);
      if (geo.geoLatitudeMicro == null || geo.geoLongitudeMicro == null) {
        errors.push(`${provider.name} no coordinates`);
        continue;
      }
      return geo;
    } catch (error: any) {
      errors.push(error?.name === "AbortError" ? `${provider.name} timeout` : String(error?.message || error));
    }
  }
  throw new Error(errors.join("; ") || "no geo provider available");
}

function cacheEntryFromRow(row: any): AddressGeoCacheEntry | null {
  const value = cacheResultFromRow(row);
  if (!value) return null;
  const fetchedAt = toTime(row?.fetchedAt);
  const expiresAt = Number(row?.expiresAt || 0);
  return {
    freshUntil: fetchedAt > 0 ? fetchedAt + ADDRESS_GEO_FRESH_MS : Date.now(),
    expiresAt: expiresAt > 0 ? expiresAt * 1000 : Date.now() + ADDRESS_GEO_STALE_MS,
    value,
  };
}

async function readPersistentGeoCacheEntry(cacheKey: string) {
  const q = quoteIdentifier;
  const nowSec = epochSeconds();
  const rows = await queryRaw<any>(
    `SELECT ${q("address")}, ${q("resolvedAddress")}, ${q("geoCountryCode")}, ${q("geoCountryName")}, ${q("geoRegion")}, ${q("geoEmoji")}, ${q("geoLatitudeMicro")}, ${q("geoLongitudeMicro")}, ${q("fetchedAt")}, ${q("expiresAt")}
       FROM ${q("ip_geo_cache")}
      WHERE ${q("address")} = ? AND ${q("expiresAt")} > ?
      LIMIT 1`,
    [cacheKey, nowSec],
  ).catch(() => []);
  const entry = cacheEntryFromRow(rows[0]);
  if (entry) setAddressGeoCache(cacheKey, entry);
  return entry;
}

async function writePersistentGeoCache(cacheKey: string, value: AddressGeoLookupResult) {
  const nowSec = epochSeconds();
  const expiresAt = Math.floor((Date.now() + ADDRESS_GEO_STALE_MS) / 1000);
  const q = quoteIdentifier;
  const table = q("ip_geo_cache");
  const columns = [
    "address",
    "resolvedAddress",
    "geoCountryCode",
    "geoCountryName",
    "geoRegion",
    "geoEmoji",
    "geoLatitudeMicro",
    "geoLongitudeMicro",
    "provider",
    "fetchedAt",
    "expiresAt",
  ];
  const params = [
    cacheKey,
    value.resolvedAddress,
    value.geoCountryCode,
    value.geoCountryName,
    value.geoRegion,
    value.geoEmoji,
    value.geoLatitudeMicro,
    value.geoLongitudeMicro,
    value.provider || "unknown",
    nowSec,
    expiresAt,
  ];
  await executeRaw(`DELETE FROM ${table} WHERE ${q("address")} = ?`, [cacheKey]).catch(() => undefined);
  await executeRaw(
    `INSERT INTO ${table} (${columns.map(q).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    params,
  ).catch(() => undefined);
}

/**
 * 清掉已经过期的地理缓存行。
 *
 * expiresAt 写入时就已经是「抓取时间 + 30 天」，过了它这一行再也不会被读
 * （readPersistentGeoCacheEntry 只要 expiresAt > now 的）。原来这里又往回减了 30 天，
 * 过期行要白白多躺一个月才被删。
 */
export async function cleanOldAddressGeoCache() {
  const cutoff = epochSeconds();
  await executeRaw(
    `DELETE FROM ${quoteIdentifier("ip_geo_cache")} WHERE ${quoteIdentifier("expiresAt")} <= ?`,
    [cutoff],
  ).catch(() => undefined);
}

async function lookupAddressGeoUncached(normalized: string, cacheKey: string): Promise<AddressGeoLookupResult | null> {
  const staleEntry = await readPersistentGeoCacheEntry(cacheKey);
  if (staleEntry && staleEntry.freshUntil > Date.now()) return staleEntry.value;
  if (staleEntry?.value && staleEntry.expiresAt > Date.now() && allGeoProvidersRateLimited()) return staleEntry.value;

  const resolvedAddress = await resolveLookupAddress(normalized);
  if (!resolvedAddress || isPrivateAddress(resolvedAddress)) {
    setAddressGeoCache(cacheKey, { freshUntil: Date.now() + ADDRESS_GEO_NEGATIVE_CACHE_MS, expiresAt: Date.now() + ADDRESS_GEO_NEGATIVE_CACHE_MS, value: null });
    return null;
  }

  const resolvedKey = resolvedAddress.toLowerCase();
  if (resolvedKey !== cacheKey) {
    const resolvedEntry = await readPersistentGeoCacheEntry(resolvedKey);
    if (resolvedEntry && resolvedEntry.freshUntil > Date.now() && resolvedEntry.value) {
      const value = { ...resolvedEntry.value, address: normalized, resolvedAddress };
      setAddressGeoCache(cacheKey, { ...resolvedEntry, value });
      await writePersistentGeoCache(cacheKey, value);
      return value;
    }
  }

  let geo: Awaited<ReturnType<typeof fetchHostGeo>>;
  try {
    geo = await fetchHostGeo(resolvedAddress);
  } catch (error) {
    if (staleEntry?.value) return staleEntry.value;
    if (resolvedKey !== cacheKey) {
      const resolvedStaleEntry = await readPersistentGeoCacheEntry(resolvedKey);
      if (resolvedStaleEntry?.value) return { ...resolvedStaleEntry.value, address: normalized, resolvedAddress };
    }
    throw error;
  }
  const value: AddressGeoLookupResult = {
    address: normalized,
    resolvedAddress,
    ...geo,
  };
  console.info(`[HostGeo] located address=${normalized} provider=${geo.provider} country=${geo.geoCountryCode} region=${geo.geoRegion || "-"}`);
  setAddressGeoCache(cacheKey, { freshUntil: Date.now() + ADDRESS_GEO_FRESH_MS, expiresAt: Date.now() + ADDRESS_GEO_STALE_MS, value });
  await writePersistentGeoCache(cacheKey, value);
  if (resolvedKey !== cacheKey) {
    await writePersistentGeoCache(resolvedKey, { ...value, address: resolvedAddress });
  }
  return value;
}

async function refreshHostGeo(host: any, options: { force?: boolean } = {}) {
  const hostId = Number(host?.id) || 0;
  if (!hostId || refreshingHostIds.has(hostId)) return null;
  if (host?.geoManual) return null;
  if (!options.force && !isRefreshDue(host)) return null;

  refreshingHostIds.add(hostId);
  try {
    const address = pickLookupAddress(host);
    if (!address) {
      noteHostGeoFailure(hostId);
      return null;
    }
    const geo = await lookupAddressGeo(address);
    if (!geo) {
      const delay = noteHostGeoFailure(hostId);
      console.warn(`[HostGeo] unlocated host=${hostId} address=${address}; retry in ${Math.round(delay / 60000)}min`);
      return null;
    }
    /*
      查询是异步的，期间用户可能刚好在对话框里把位置改成了手动 —— 写之前再读一次
      标记，别把人家刚填的覆盖掉。
    */
    const current = await db.getHostById(hostId);
    if (!current || (current as any).geoManual) return null;
    await db.updateHost(hostId, {
      geoCountryCode: geo.geoCountryCode,
      geoCountryName: geo.geoCountryName,
      geoRegion: geo.geoRegion,
      geoEmoji: geo.geoEmoji,
      geoLatitudeMicro: geo.geoLatitudeMicro,
      geoLongitudeMicro: geo.geoLongitudeMicro,
      geoUpdatedAt: geo.geoUpdatedAt,
    } as any);
    hostGeoRetryState.delete(hostId);
    return geo;
  } catch (error: any) {
    noteHostGeoFailure(hostId);
    console.warn(`[HostGeo] refresh failed host=${hostId}:`, error?.message || error);
    return null;
  } finally {
    refreshingHostIds.delete(hostId);
  }
}

/**
 * 把一台主机从「手动」改回「按 IP 自动定位」，并立刻重新查一次。
 *
 * 缓存也一并丢掉：用户点这个按钮多半是因为觉得上次自动定的不对，再把同一份
 * 缓存拿出来给他看等于没点。
 */
export async function relocateHost(hostId: number) {
  const host = await db.getHostById(hostId);
  if (!host) throw new Error("主机不存在");
  await db.updateHost(hostId, {
    geoManual: false,
    geoCountryCode: null,
    geoCountryName: null,
    geoRegion: null,
    geoEmoji: null,
    geoLatitudeMicro: null,
    geoLongitudeMicro: null,
    geoUpdatedAt: null,
  } as any);
  hostGeoRetryState.delete(hostId);
  const address = pickLookupAddress(host);
  if (address) await evictAddressGeoCache(address);
  return refreshHostGeo({ ...host, geoManual: false, geoCountryCode: null, geoLatitudeMicro: null, geoLongitudeMicro: null }, { force: true });
}

async function evictAddressGeoCache(address: string) {
  const normalized = normalizeLookupAddress(address);
  if (!normalized) return;
  const cacheKey = normalized.toLowerCase();
  addressGeoCache.delete(cacheKey);
  const q = quoteIdentifier;
  await executeRaw(`DELETE FROM ${q("ip_geo_cache")} WHERE ${q("address")} = ?`, [cacheKey]).catch(() => undefined);
  const resolved = await resolveLookupAddress(normalized).catch(() => "");
  const resolvedKey = String(resolved || "").toLowerCase();
  if (resolvedKey && resolvedKey !== cacheKey) {
    addressGeoCache.delete(resolvedKey);
    await executeRaw(`DELETE FROM ${q("ip_geo_cache")} WHERE ${q("address")} = ?`, [resolvedKey]).catch(() => undefined);
  }
}

/**
 * 定时补漏：把还没定到位、也不是手动的主机挨个再查一遍。
 *
 * 串行而不是并发 —— 三家服务都是免费额度，一口气打几十个请求正好把自己
 * 限流。退避在 isRefreshDue 里管着，这里只是把到点的挑出来。
 */
export async function runHostGeoSweep() {
  const rows = await db.getHostsMissingGeo();
  let located = 0;
  let attempted = 0;
  for (const host of rows) {
    if (!isRefreshDue(host)) continue;
    attempted += 1;
    if (await refreshHostGeo(host)) located += 1;
    if (allGeoProvidersRateLimited()) break;
  }
  if (attempted > 0) console.info(`[HostGeo] sweep attempted=${attempted} located=${located} pending=${rows.length}`);
  return { attempted, located, pending: rows.length };
}

export async function lookupAddressGeo(address: string): Promise<AddressGeoLookupResult | null> {
  const normalized = normalizeLookupAddress(address);
  if (!normalized) return null;
  const cacheKey = normalized.toLowerCase();
  const cached = addressGeoCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() && cached.freshUntil > Date.now()) return cached.value;
  if (cached?.value && cached.expiresAt > Date.now() && allGeoProvidersRateLimited()) return cached.value;
  const inflight = addressGeoInflight.get(cacheKey);
  if (inflight) return inflight;

  const promise = lookupAddressGeoUncached(normalized, cacheKey)
    .catch((error: any) => {
      const fallback = addressGeoCache.get(cacheKey);
      if (fallback?.value && fallback.expiresAt > Date.now()) return fallback.value;
      setAddressGeoCache(cacheKey, { freshUntil: Date.now() + ADDRESS_GEO_NEGATIVE_CACHE_MS, expiresAt: Date.now() + ADDRESS_GEO_NEGATIVE_CACHE_MS, value: null });
      console.warn(`[HostGeo] lookup failed address=${normalized}:`, error?.message || error);
      return null;
    })
    .finally(() => {
      addressGeoInflight.delete(cacheKey);
    });
  addressGeoInflight.set(cacheKey, promise);
  return promise;
}

export function scheduleHostGeoRefresh(hostRows: any[]) {
  const dueHosts = hostRows.filter(isRefreshDue);
  for (const host of dueHosts) {
    void refreshHostGeo(host);
  }
}
