/**
 * 一台机器在搜索框里能被什么词命中，链路管理和转发组原来各存一份。
 *
 * 两页各存一份的后果很具体：在链路管理里用 DDNS 域名搜得到，到转发组里同一个
 * 词搜不到 —— 人会以为那台机器不在这个组里。这份清单是**能不能搜到**的定义，
 * 只该有一处。
 */
export function hostSearchParts(host: any | null | undefined) {
  if (!host) return [];
  return [
    host.id,
    host.name,
    host.hostname,
    host.ip,
    host.ipv4,
    host.ipv6,
    host.publicIp,
    host.entryIp,
    host.tunnelEntryIp,
    host.ddnsDomain,
    host.region,
    host.country,
    host.os,
    host.system,
    host.agentVersion,
  ];
}
