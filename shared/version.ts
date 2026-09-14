/**
 * 版本号比较，全站唯一一份。
 *
 * 原来有四份 normalizeVersion、三份 compareVersions（server/agentRouteUtils.ts、
 * server/_core/systemRouter.ts、server/routers/hosts.ts、
 * client/src/components/hosts/hostDisplay.tsx），一字不差。面板判断「要不要提示
 * 升级」、后端判断「这台 Agent 支不支持某个能力」、主机卡上那个「发现新版本」
 * 角标，走的本该是同一把尺子 —— 四份各自演化的话，界面说该升、后端说不用升，
 * 谁也说不清到底该信哪个。
 */
export function normalizeVersion(version: string | null | undefined) {
  return String(version || "").trim().replace(/^v/i, "");
}

/** a > b 回 1，a < b 回 -1，相等回 0。缺的位按 0 补，所以 2.3 和 2.3.0 相等。 */
export function compareVersions(a: string | null | undefined, b: string | null | undefined) {
  const pa = normalizeVersion(a).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = normalizeVersion(b).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 这台 Agent 的版本够不够某个能力的门槛。
 *
 * 任一边为空时回 false —— 版本号没上报过就当成「不够」，宁可少下发一个新能力，
 * 也不能对着一台不认识这条指令的 Agent 发过去。
 */
export function isAgentVersionAtLeast(version: string | null | undefined, target: string | null | undefined) {
  if (!version || !target) return false;
  return compareVersions(version, target) >= 0;
}

/** 落后于目标版本才算「该升级」；同样，缺版本号时不提示。 */
export function isAgentVersionBehind(version: string | null | undefined, target: string | null | undefined) {
  if (!version || !target) return false;
  return compareVersions(version, target) < 0;
}
