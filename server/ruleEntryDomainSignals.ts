/*
  仓库层 → 规则专属域名同步（server/ruleEntryDomain.ts）的通知口。

  仓库文件不能静态 import 同步模块：它经 ddns 引到 ./db，而 ./db 又 re-export 这些仓库，
  会成环。这里不依赖任何东西，同步模块加载时自己来登记（面板运行时调度器、设置接口
  都静态引了它，启动即登记）；登记之前的通知先攒着，登记时一并交过去。这里不主动去
  加载同步模块：只测仓库的单元测试不该被顺带拉起 DNS 同步。

  通知是同步调用的：规则一保存，防抖定时器当场就挂上，不会因为一次动态 import
  的异步间隙漏掉（测试里 waitForRuleEntryDomainIdle 也靠这一点）。
*/

type RuleEntryDomainListener = {
  sync(ruleId: number, reason: string): void;
  cleanup(reason: string): void;
};

let listener: RuleEntryDomainListener | null = null;
const pendingSyncs = new Map<number, string>();
let pendingCleanup: string | null = null;
const MAX_PENDING = 10_000;

export function registerRuleEntryDomainListener(next: RuleEntryDomainListener) {
  listener = next;
  const syncs = Array.from(pendingSyncs.entries());
  pendingSyncs.clear();
  for (const [ruleId, reason] of syncs) next.sync(ruleId, reason);
  if (pendingCleanup) {
    const reason = pendingCleanup;
    pendingCleanup = null;
    next.cleanup(reason);
  }
}

/** 规则的入口主机 / 开关 / 删除 / 订阅绑定变了。 */
export function signalRuleEntryDomainChanged(ruleIdValue: unknown, reason: string) {
  const ruleId = Number(ruleIdValue);
  if (!Number.isInteger(ruleId) || ruleId <= 0) return;
  if (listener) {
    listener.sync(ruleId, reason);
    return;
  }
  // 攒不下就算了：定时对账会补上。
  if (pendingSyncs.size < MAX_PENDING) pendingSyncs.set(ruleId, reason);
}

/** 有规则行被真正删掉，待删表里多了要删的域名。 */
export function signalRuleEntryDomainCleanup(reason: string) {
  if (listener) {
    listener.cleanup(reason);
    return;
  }
  pendingCleanup = reason;
}
