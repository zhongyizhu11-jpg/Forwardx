import { and, eq, gt, isNull } from "drizzle-orm";
import { authSessions, users } from "../../drizzle/schema";
import { getDb, nowDate } from "../dbRuntime";
import { getSessionKindField, SESSION_TOUCH_INTERVAL_MS, type SessionKind } from "../session";
import { deleteExpiredHistoryRows } from "./historyRetention";

type CreateAuthSessionInput = {
  userId: number;
  sid: string;
  kind: SessionKind;
  expiresAt: Date;
};

function activeSessionWhere(userId: number, sid: string, kind: SessionKind, now = nowDate()) {
  return and(
    eq(authSessions.userId, userId),
    eq(authSessions.sid, sid),
    eq(authSessions.kind, kind),
    isNull(authSessions.revokedAt),
    gt(authSessions.expiresAt, now),
  );
}

export async function createAuthSession(input: CreateAuthSessionInput) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const now = nowDate();
  await db.insert(authSessions).values({
    userId: input.userId,
    sid: input.sid,
    kind: input.kind,
    expiresAt: input.expiresAt,
    createdAt: now,
    lastSeenAt: now,
  } as any);
}

export async function getActiveAuthSession(userId: number, sid: string, kind: SessionKind) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(authSessions).where(activeSessionWhere(userId, sid, kind)).limit(1);
  return rows[0];
}

/**
 * 刷新会话的 lastSeenAt（按 SESSION_TOUCH_INTERVAL_MS 节流）。
 *
 * loadedSession：调用方刚用 getActiveAuthSession 读过的同一行。每个请求解析会话时
 * 已经读过一次，这里再读一遍纯属重复（每个已登录请求多一条查询）。传进来就只用它的
 * lastSeenAt 判断要不要写；真正的 UPDATE 仍带着「未撤销、未过期」的条件，
 * 所以两次之间被并发撤销的会话不会被这次写回来 —— 撤销照样赢。
 */
export async function touchAuthSession(
  userId: number,
  sid: string,
  kind: SessionKind,
  loadedSession?: { lastSeenAt?: unknown } | null,
) {
  const db = await getDb();
  if (!db) return;
  const session = loadedSession ?? await getActiveAuthSession(userId, sid, kind);
  if (!session) return;
  const lastSeenAt = new Date((session as any).lastSeenAt || 0).getTime();
  if (Number.isFinite(lastSeenAt) && Date.now() - lastSeenAt < SESSION_TOUCH_INTERVAL_MS) return;
  await db.update(authSessions)
    .set({ lastSeenAt: nowDate() } as any)
    .where(activeSessionWhere(userId, sid, kind));
}

export async function revokeAuthSession(userId: number, sid: string, kind: SessionKind, reason = "logout") {
  const db = await getDb();
  if (!db) return;
  await db.update(authSessions)
    .set({ revokedAt: nowDate(), revokeReason: reason } as any)
    .where(and(
      eq(authSessions.userId, userId),
      eq(authSessions.sid, sid),
      eq(authSessions.kind, kind),
      isNull(authSessions.revokedAt),
    ));
}

export async function revokeUserAuthSessions(userId: number, options: { kind?: SessionKind; reason?: string } = {}) {
  const db = await getDb();
  if (!db) return;
  const conditions = [eq(authSessions.userId, userId), isNull(authSessions.revokedAt)];
  if (options.kind) conditions.push(eq(authSessions.kind, options.kind));
  await db.update(authSessions)
    .set({ revokedAt: nowDate(), revokeReason: options.reason || "revoked" } as any)
    .where(and(...conditions));

  const leasePatch = options.kind
    ? { [getSessionKindField(options.kind)]: null }
    : {
        browserSessionToken: null,
        mobileSessionToken: null,
        telegramSessionToken: null,
      };
  await db.update(users).set(leasePatch as any).where(eq(users.id, userId));
}

/**
 * 清掉早已失效的会话行：过期超过 retainDays 天的，或被撤销超过 retainDays 天的。
 *
 * 每次登录插一行、退出/被顶掉只是打上 revokedAt，从来没人删 —— 跑一年的面板里
 * 这张表几乎全是死行。唯一的读取方 getActiveAuthSession 只认「未撤销且未过期」的行，
 * 所以删掉这些不影响任何判断；留 7 天只是方便排查最近的登录问题。
 */
export async function pruneStaleAuthSessions(retainDays = 7) {
  const db = await getDb();
  if (!db) return 0;
  const cutoff = Math.floor((Date.now() - Math.max(1, retainDays) * 24 * 3600 * 1000) / 1000);
  // 两个条件分两轮删：revokedAt 为 NULL 时「< ?」为假，不会误删未撤销的行。
  // revokedAt 没有索引，按主键顺序分批。
  const expired = await deleteExpiredHistoryRows("auth_sessions", "expiresAt", cutoff);
  const revoked = await deleteExpiredHistoryRows("auth_sessions", "revokedAt", cutoff, { orderColumn: "id" });
  return expired + revoked;
}
