/**
 * 今天还能改几次头像。
 *
 * 这几行原来只写在个人资料页。侧边栏的账户菜单里也能换头像，但它**没有这个
 * 前置判断** —— 用户在那儿挑完、裁完、点保存，才被服务端顶回来一句
 * 「头像每天最多修改 N 次」。个人资料页是点保存前就告诉你的。
 *
 * （额度本身服务端一直在管，`userRepository` 里会抛错，所以侧边栏那条路
 * 只是体验更差，不是绕过了限制。查过才敢这么说。）
 */

export type AvatarQuota = { remaining?: number | null; unlimited?: boolean | null } | null | undefined;

/** 查询还没回来时按 3 次算 —— 和个人资料页原来的默认值一致，不要凭空改。 */
const DEFAULT_REMAINING = 3;

export function avatarQuotaState(quota: AvatarQuota, isAdmin: boolean) {
  const remaining = quota?.remaining ?? DEFAULT_REMAINING;
  const unlimited = !!quota?.unlimited || isAdmin;
  return { remaining, unlimited, exhausted: !unlimited && remaining <= 0 };
}
