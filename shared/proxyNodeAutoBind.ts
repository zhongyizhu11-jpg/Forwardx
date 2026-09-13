/**
 * 建转发时自动认出「这条其实是通往我自己某个落地节点的」。
 *
 * 订阅和转发在这套面板里本来就是一件事的两面：一条转发把入口机的端口接到落地机
 * 上，而订阅里那条中转线路描述的就是同一件事。可是这两件事原来要分两处做 —— 在
 * 转发页建规则，再去订阅页的预览弹窗里把它绑到落地节点上。不绑就不进订阅，而
 * 转发页上完全看不出少了这一步：转发跑得好好的，客户端里却没有这条线路。
 *
 * 这份逻辑做的事很小：转发的目标地址端口，正好等于某个落地节点的地址端口时，
 * 认出它是哪一个。判错的后果是把**别人的线路**塞进订阅，所以宁可不认：
 *
 * - 只认完全相同的 address:port，不做任何模糊匹配；
 * - 停用的节点不认（它本来就不该出现在订阅里）；
 * - 认出多个就一个都不认 —— 猜错一次就是订阅里指向了错的落地机；
 * - 自己的节点优先于别人分享给自己的：同地址时，主人那条才是「我的线路」。
 */

export type AutoBindCandidate = {
  id: number;
  address: string;
  port: number;
  isEnabled?: boolean;
  /** 别人分享给我的节点。同地址时让位给自己的那条。 */
  sharedFrom?: boolean;
};

function normalizeAddress(value: unknown): string {
  return String(value ?? "").trim().toLowerCase()
    // IPv6 字面量在转发那边可能带方括号，节点那边不一定带 —— 去掉再比。
    .replace(/^\[/, "")
    .replace(/\]$/, "");
}

/**
 * 这条转发的目标，对应哪一个落地节点。认不出返回 null。
 */
export function matchProxyNodeForTarget(
  candidates: readonly AutoBindCandidate[],
  targetAddress: unknown,
  targetPort: unknown,
): AutoBindCandidate | null {
  const address = normalizeAddress(targetAddress);
  const port = Number(targetPort);
  if (!address || !Number.isInteger(port) || port <= 0) return null;

  const matches = candidates.filter((node) =>
    node.isEnabled !== false
    && Number(node.port) === port
    && normalizeAddress(node.address) === address);
  if (matches.length === 0) return null;

  const owned = matches.filter((node) => !node.sharedFrom);
  // 自己的节点优先；自己名下仍然有多个同地址同端口的，说明本来就分不清，不猜。
  const pool = owned.length > 0 ? owned : matches;
  return pool.length === 1 ? pool[0] : null;
}

/**
 * 这次保存该不该自动绑。
 *
 * 只在两种时机认：**新建**，以及**改了目标地址之后仍然没有绑定**。
 *
 * 不在每次保存时都认，是为了尊重「他手动解绑过」这件事：解绑的人不会顺手改目标，
 * 所以只要目标没变就不再自作主张。已经绑了别的节点的更不能动 —— 那是他明确选过的。
 */
export function shouldAutoBindProxyNode(input: {
  isCreate: boolean;
  /** 保存后这条规则的绑定；> 0 表示调用方已经明确指定了节点。 */
  boundNodeId?: number | null;
  targetChanged?: boolean;
}): boolean {
  if (Number(input.boundNodeId || 0) > 0) return false;
  return input.isCreate || input.targetChanged === true;
}

/**
 * 反过来的一半：**刚建好一个落地节点**，把已经指向它的转发认出来。
 *
 * 先有转发、后加节点是很常见的顺序：机器先跑起来，过几天才想起来「这条其实可以
 * 进订阅」。这时候如果只有正向自动绑定（建转发时认节点），这些早就存在的转发永远
 * 不会自己进订阅 —— 而它们本来就是通往这个节点的。
 *
 * 这个方向反而更安全：节点是**刚建的**，在它存在之前谁也没机会「手动解绑」，
 * 所以不存在「他解绑了、面板又绑回去」的问题。已经绑着别的节点的仍然不动。
 */
export function rulesMatchingProxyNode<T extends {
  id: number;
  targetIp?: unknown;
  targetPort?: unknown;
  proxyNodeId?: unknown;
}>(
  rules: readonly T[],
  node: { address: unknown; port: unknown },
): T[] {
  const address = normalizeAddress(node.address);
  const port = Number(node.port);
  if (!address || !Number.isInteger(port) || port <= 0) return [];
  return rules.filter((rule) =>
    Number(rule.proxyNodeId || 0) === 0
    && Number(rule.targetPort) === port
    && normalizeAddress(rule.targetIp) === address);
}
