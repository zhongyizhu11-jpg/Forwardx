import { classifyIpAddress } from "../shared/ipAddress";

/*
  Agent 上报的本机内网 IPv4（默认网卡上的 10/8、172.16/12、192.168/16、100.64/10）。

  只用来在「编辑主机」里给「内网地址」做建议，点一下才填进去 —— 不自动写进
  tunnelEntryIp：那一栏决定隧道走内网还是公网，不在同一个内网的两台机器被
  自动填上会直接连不通。

  放内存不落库：Agent 每次心跳都会带上，面板重启后一次心跳就回来了。
*/
const privateIpv4ByHost = new Map<number, string>();
const MAX_ENTRIES = 8192;

export function noteAgentPrivateIpv4(hostId: number, value: unknown) {
  const id = Number(hostId) || 0;
  if (!id) return;
  const address = String(value ?? "").trim();
  if (!address) return;
  if (address.length > 15 || !/^\d{1,3}(\.\d{1,3}){3}$/.test(address) || classifyIpAddress(address) !== "private") return;
  if (privateIpv4ByHost.get(id) === address) return;
  privateIpv4ByHost.delete(id);
  privateIpv4ByHost.set(id, address);
  while (privateIpv4ByHost.size > MAX_ENTRIES) {
    const oldest = privateIpv4ByHost.keys().next().value;
    if (oldest == null) break;
    privateIpv4ByHost.delete(oldest);
  }
}

export function agentPrivateIpv4(hostId: unknown) {
  return privateIpv4ByHost.get(Number(hostId) || 0) || null;
}
