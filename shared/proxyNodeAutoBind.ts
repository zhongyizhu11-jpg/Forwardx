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

/**
 * 绑定还算不算真的。
 *
 * 绑定这件事声明的是「这条转发通向那个落地节点」。可它只在保存那一刻成立过 ——
 * 之后目标地址能改、节点自己的地址端口也能改，而绑定关系一直留着。留错了不只是
 * 少一条线路：订阅里那条节点**带着这个落地的凭据**（uuid、Reality 公钥、SNI），
 * 地址却写的是转发入口；入口现在通向别处，客户端就会把这套凭据递给那台别的机器。
 *
 * 所以要能判断，但**判不准时必须说判不准**，而不是猜：
 *
 * - 端口不一样 → 一定不通。中转要成立，转发的目标端口就得是节点监听的那个端口。
 * - 两边都是 IP 字面量且不同 → 一定不是同一台机器。
 * - 有一边是域名 → 不下结论。同一台机器完全可以一边写 IP、一边写 DDNS 域名，
 *   这里没有 DNS 可查，硬判会把好好的线路判成坏的。
 * - 少了字段（调用方没查那几列）→ 不下结论。
 */
export type ProxyNodeBindingTruth = "matches" | "mismatch" | "unknown";

function isLiteralIp(value: string): boolean {
  if (!value) return false;
  // IPv4 点分十进制
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return true;
  // IPv6：只要出现两个及以上冒号就当字面量（域名里不会有冒号）
  return (value.match(/:/g) || []).length >= 2;
}

export function proxyNodeBindingTruth(
  rule: { targetIp?: unknown; targetPort?: unknown },
  node: { address?: unknown; port?: unknown },
): ProxyNodeBindingTruth {
  const target = normalizeAddress(rule?.targetIp);
  const nodeAddress = normalizeAddress(node?.address);
  const targetPort = Number(rule?.targetPort);
  const nodePort = Number(node?.port);
  if (!target || !nodeAddress) return "unknown";
  if (!Number.isInteger(targetPort) || targetPort <= 0) return "unknown";
  if (!Number.isInteger(nodePort) || nodePort <= 0) return "unknown";

  if (target === nodeAddress) return targetPort === nodePort ? "matches" : "mismatch";
  if (targetPort !== nodePort) return "mismatch";
  // 地址不同、端口相同：只有两边都是 IP 字面量才敢说不是同一台机器。
  return isLiteralIp(target) && isLiteralIp(nodeAddress) ? "mismatch" : "unknown";
}

/**
 * 这次保存之后，绑定该怎么动。
 *
 * 决策全在这里，写库留给调用方 —— 这样「什么情况下动、动成什么」可以单独测，
 * 而它判错的代价不小：把订阅里一条好线路解掉，或者留着一条把凭据递给别人的线路。
 *
 * 规矩：
 *
 * - 没绑过的，按 shouldAutoBindProxyNode 认一次。
 * - 绑过的，**只在原来字面相符时**才重新对。字面相符说明这个绑定是面板自己认出来
 *   的（或者等价于认出来的），面板有责任让它继续为真；不相符的那些是他自己搭的
 *   拓扑（串两跳、一边域名一边 IP），我们没有判断权，一个字都不动。
 * - 重新对的结果：新目标正好是另一个节点 → 改绑；谁都不是 → 解绑。
 */
export type ProxyNodeBindingAction =
  | { action: "none" }
  | { action: "bind"; nodeId: number }
  | { action: "rebind"; nodeId: number }
  | { action: "release" };

export function planProxyNodeBinding(input: {
  isCreate: boolean;
  targetChanged?: boolean;
  boundNodeId?: number | null;
  /** 绑着的那个节点现在在哪。查不到（删了、分享撤了）就给 null。 */
  boundNodePlace?: { address?: unknown; port?: unknown } | null;
  previousTarget?: { targetIp?: unknown; targetPort?: unknown };
  nextTarget: { targetIp?: unknown; targetPort?: unknown };
  candidates: readonly AutoBindCandidate[];
}): ProxyNodeBindingAction {
  const boundNodeId = Number(input.boundNodeId || 0);
  if (boundNodeId > 0) {
    if (!input.targetChanged) return { action: "none" };
    // 绑的节点已经不在了：解绑那条路由删除流程负责，这里不掺和。
    if (!input.boundNodePlace) return { action: "none" };
    const wasLiteral = proxyNodeBindingTruth(input.previousTarget || {}, input.boundNodePlace) === "matches";
    if (!wasLiteral) return { action: "none" };
    if (proxyNodeBindingTruth(input.nextTarget, input.boundNodePlace) === "matches") return { action: "none" };
    const rematched = matchProxyNodeForTarget(
      input.candidates,
      input.nextTarget.targetIp,
      input.nextTarget.targetPort,
    );
    if (rematched && rematched.id !== boundNodeId) return { action: "rebind", nodeId: rematched.id };
    return { action: "release" };
  }

  if (!shouldAutoBindProxyNode({
    isCreate: input.isCreate,
    boundNodeId,
    targetChanged: input.targetChanged,
  })) return { action: "none" };
  const matched = matchProxyNodeForTarget(
    input.candidates,
    input.nextTarget.targetIp,
    input.nextTarget.targetPort,
  );
  return matched ? { action: "bind", nodeId: matched.id } : { action: "none" };
}
