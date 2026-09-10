import assert from "node:assert/strict";
import test from "node:test";

import { mergeManualAndPlanLimits } from "./repositories/billingRepository";

/**
 * 客户端订阅权限来自两处：管理员的手动授权，以及在用套餐附带的权限。
 * 这里只验证合并规则本身；超流量与暂停的收回在 syncUserSubscriptionEntitlements
 * 里处理，由订阅路由的端到端用例覆盖。
 */
test("手动授权或套餐授权任一成立即可使用客户端订阅", () => {
  const cases: Array<[boolean, boolean, boolean]> = [
    // 手动, 套餐, 期望
    [false, false, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ];

  for (const [manual, plan, expected] of cases) {
    const merged = mergeManualAndPlanLimits(
      { manualAllowProxySubscription: manual },
      { allowProxySubscription: plan },
    );
    assert.equal(
      merged.allowProxySubscription,
      expected,
      `手动=${manual} 套餐=${plan} 时应为 ${expected}`,
    );
  }
});

test("订阅权限独立于转发权限，不会被 canAddRules 带出来", () => {
  // 有套餐（因此能建转发），但套餐没附带订阅权限。
  const merged = mergeManualAndPlanLimits(
    { manualCanAddRules: false },
    { canAddRules: true, allowForwardXTunnel: true, allowProxySubscription: false },
  );

  assert.equal(merged.canAddRules, true);
  assert.equal(merged.allowForwardXTunnel, true);
  // 关键：能建转发不等于能用订阅，否则「单独控制」就形同虚设。
  assert.equal(merged.allowProxySubscription, false);
});

test("字段缺失时按无权限处理", () => {
  assert.equal(mergeManualAndPlanLimits({}, {}).allowProxySubscription, false);
  assert.equal(mergeManualAndPlanLimits(null, null).allowProxySubscription, false);
});
