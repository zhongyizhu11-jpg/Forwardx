import { getEntryAddressFamily } from "@shared/hostEntryAddress";

// 地址族判定与入口地址推导已统一到 shared，服务端生成订阅要用同一份实现。
export { getEntryAddressFamily };
export type { EntryAddressFamily } from "@shared/hostEntryAddress";

export type RuleEntryAddress = {
  label: string;
  value: string;
};

/**
 * Resolve an entry host from the global host list, falling back to an
 * ACL-filtered nested host returned with a shared group/tunnel. Shared
 * resources can intentionally omit their member hosts from hosts.options,
 * but the nested summary still contains the public/DDNS address needed by
 * the rules display.
 */
export function resolveRuleEntryHost<T extends { id?: unknown }>(
  hosts: readonly T[] | null | undefined,
  hostId: unknown,
  nestedHost?: T | null,
): T | null {
  const id = Number(hostId || 0);
  if (id > 0) {
    return hosts?.find((host) => Number(host?.id || 0) === id) || nestedHost || null;
  }
  return nestedHost || null;
}

export function filterRuleEntryAddressesForDisplay<T extends RuleEntryAddress>(entries: readonly T[]): T[] {
  const hasIpv4OrHostname = entries.some((entry) => {
    const family = getEntryAddressFamily(entry.value);
    return family === "ipv4" || family === "hostname";
  });
  if (!hasIpv4OrHostname) return entries.slice();
  return entries.filter((entry) => getEntryAddressFamily(entry.value) !== "ipv6");
}
