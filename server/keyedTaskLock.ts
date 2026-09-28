import { AsyncLocalStorage } from "node:async_hooks";

type PendingTask = {
  tail: Promise<void>;
  depth: number;
};

const pendingTasks = new Map<string, PendingTask>();
type TrafficBillingLockToken = { active: boolean };
const trafficBillingLockContext = new AsyncLocalStorage<Map<string, TrafficBillingLockToken>>();

export function trafficBillingUserLockKey(userId: unknown) {
  const id = Number(userId || 0);
  return `traffic-billing-user:${Number.isFinite(id) && id > 0 ? Math.floor(id) : 0}`;
}

export async function withKeyedTaskLock<T>(keyValue: unknown, task: () => Promise<T>): Promise<T> {
  const key = String(keyValue || "").trim();
  if (!key) return task();

  const previous = pendingTasks.get(key);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const current: PendingTask = {
    tail: gate,
    depth: (previous?.depth || 0) + 1,
  };
  pendingTasks.set(key, current);

  if (previous) await previous.tail;
  try {
    return await task();
  } finally {
    release();
    if (pendingTasks.get(key) === current) pendingTasks.delete(key);
  }
}

export async function withTrafficBillingUserLock<T>(userId: unknown, task: () => Promise<T>): Promise<T> {
  const key = trafficBillingUserLockKey(userId);
  const inheritedLocks = trafficBillingLockContext.getStore();
  if (inheritedLocks?.get(key)?.active) return task();

  return withKeyedTaskLock(key, () => {
    const token = { active: true };
    const heldLocks = new Map(inheritedLocks);
    heldLocks.set(key, token);
    return trafficBillingLockContext.run(heldLocks, async () => {
      try {
        return await task();
      } finally {
        token.active = false;
      }
    });
  });
}

/**
 * 在已经用 withKeyedTaskLock(trafficBillingUserLockKey(userId)) 拿到锁的任务里调用：
 * 把「持有这把锁」记进上下文，里面再走 withTrafficBillingUserLock 时按重入处理。
 *
 * 不这样做的话，持锁的一方去同步转发组、同步里删子规则结算流量又要这把锁 ——
 * 锁不可重入，自己等自己，这个用户的计费和规则开关从此全部挂住。
 */
export function runWithTrafficBillingUserLockHeld<T>(userId: unknown, task: () => Promise<T>): Promise<T> {
  const key = trafficBillingUserLockKey(userId);
  const token = { active: true };
  const heldLocks = new Map(trafficBillingLockContext.getStore());
  heldLocks.set(key, token);
  return trafficBillingLockContext.run(heldLocks, async () => {
    try {
      return await task();
    } finally {
      token.active = false;
    }
  });
}

export function keyedTaskDepth(keyValue: unknown) {
  return pendingTasks.get(String(keyValue || "").trim())?.depth || 0;
}

export function clearKeyedTaskLocksForTest() {
  pendingTasks.clear();
}
