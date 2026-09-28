export const DEFAULT_SELF_SERVICE_HOST_LIMIT = 10;

/**
 * 自助加机器的额度检查。
 *
 * 「我的机器」把 hosts.create 摆到了界面上（在那之前它虽然也是
 * protectedProcedure，但没有入口）。机器行本身不消耗资源 —— Agent 没连上就是
 * 条死记录 —— 可它会进管理员的主机列表、进仪表盘统计，一个人灌几千条就把
 * 那些页面淹了。所以给一道刹车，默认 10 台，管理员可在系统设置里改。
 *
 * 管理员不受限：他要开满，拦了反而碍事。
 */
export function selfServiceHostLimitFrom(raw: string | null | undefined): number {
  const text = String(raw ?? "").trim();
  if (!text) return DEFAULT_SELF_SERVICE_HOST_LIMIT;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_SELF_SERVICE_HOST_LIMIT;
  return Math.floor(value);
}

/**
 * 这个人能加几台。
 *
 * 用户行上的 maxSelfServiceHosts 优先，**留空（null）才是跟随全局**：
 *
 *   - null / 没这一列 → 用全局那一档
 *   - 0              → 一台都不许加
 *   - N              → 最多 N 台
 *
 * 0 特意不当成「跟随全局」也不当成「不限」：这是个数量字段，人填 0 就是想说
 * 「一台都不给他」。当成不限就把他放开了，当成跟随全局就等于他根本没法卡死
 * 某一个人 —— 两种都和填的人想做的事相反。
 */
export function selfServiceHostLimitForUser(
  user: { maxSelfServiceHosts?: unknown } | null | undefined,
  globalLimit: number,
): number | null {
  // 全局那一档沿用老规矩：0 表示不限。这里把它翻译成 null，好和「0 台」分开。
  const globalResolved = globalLimit > 0 ? globalLimit : null;
  const raw = (user as any)?.maxSelfServiceHosts;
  if (raw === null || raw === undefined || raw === "") return globalResolved;
  const own = Math.floor(Number(raw));
  // 认不出来的值（脏数据、负数）回落到全局，不要算出一个负的上限。
  if (!Number.isFinite(own) || own < 0) return globalResolved;
  return own;
}

/**
 * 还能不能再加一台。
 *
 * limit 是 selfServiceHostLimitForUser 算出来的结果：**null 表示不限，0 表示一台
 * 都不许**。别把这两个混成同一个数 —— 早先这里写的是 `limit <= 0 return true`，
 * 那时候只有全局设置、0 就是不限；现在管理员能把某个人卡到 0，再按老规矩算就成了
 * 「卡死他反而把他放开」。
 */
export function canAddSelfServiceHost(
  user: { role: string },
  ownedCount: number,
  limit: number | null,
): boolean {
  if (user.role === "admin") return true;
  if (limit === null) return true;
  return ownedCount < limit;
}

/**
 * 这个人现在还能不能再加一台自助机器（管理员不限）。
 *
 * 手动「添加机器」和 Agent 用自己的 token 注册新机器都要过这一关：以前 token 注册
 * 不查，租户建一堆 token、各注册一次，就绕过了上限。
 */
export async function assertCanAddSelfServiceHost(
  user: { id: number; role: string; maxSelfServiceHosts?: unknown },
  deps: { getGlobalLimitRaw: () => Promise<string | null | undefined>; countOwnedHosts: (userId: number) => Promise<number> },
) {
  if (user.role === "admin") return;
  const limit = selfServiceHostLimitForUser(user, selfServiceHostLimitFrom(await deps.getGlobalLimitRaw()));
  const owned = await deps.countOwnedHosts(user.id);
  if (!canAddSelfServiceHost(user, owned, limit)) {
    throw new Error(`你自己添加的机器已达上限（${owned}/${limit}）。删掉一台，或让管理员调高上限。`);
  }
}
