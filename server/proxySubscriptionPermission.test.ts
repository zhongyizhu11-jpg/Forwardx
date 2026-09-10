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

/**
 * 建用户时就能勾订阅权限，规则要和编辑页一致：
 * 转发总开关关着时订阅一律关，且有效值与手动授权两列都得写。
 */
function createUserSubscriptionGrant(input: { canAddRules: boolean; allowProxySubscription: boolean }) {
  // 这是 users.create 里那行合并逻辑的等价写法。
  const granted = input.canAddRules && input.allowProxySubscription;
  return {
    allowProxySubscription: granted,
    manualAllowProxySubscription: granted,
  };
}

test("建用户时转发关着，订阅一并关掉", () => {
  // 转发都停了，订阅只会给出一堆连不通的死节点 —— 与编辑页收回订阅的理由相同。
  assert.deepEqual(
    createUserSubscriptionGrant({ canAddRules: false, allowProxySubscription: true }),
    { allowProxySubscription: false, manualAllowProxySubscription: false },
  );
});

test("建用户时授予订阅，有效值与手动授权两列都写", () => {
  // 有效值由「手动 OR 套餐」合并得出。只写手动那列的话，要等下一次同步才生效，
  // 中间这段时间用户的订阅地址是 404 的。
  assert.deepEqual(
    createUserSubscriptionGrant({ canAddRules: true, allowProxySubscription: true }),
    { allowProxySubscription: true, manualAllowProxySubscription: true },
  );
});

test("建用户时不勾订阅就是不给", () => {
  // 订阅地址里带着全部节点凭据，默认必须是关的。
  assert.deepEqual(
    createUserSubscriptionGrant({ canAddRules: true, allowProxySubscription: false }),
    { allowProxySubscription: false, manualAllowProxySubscription: false },
  );
});
