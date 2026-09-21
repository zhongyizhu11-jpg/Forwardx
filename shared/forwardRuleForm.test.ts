import assert from "node:assert/strict";
import test from "node:test";
import {
  forwardRuleFormBlocker,
  isForwardRuleSourcePortRequired,
  isValidForwardPort,
  type ForwardRuleFormContext,
  type ForwardRuleFormState,
} from "./forwardRuleForm";

/**
 * 「还差什么」这句话，界面上的三处必须一字不差地来自同一处。
 *
 * 按钮的禁用、footer 的提示、提交时的拦截早就读同一个值了；这一版把**标签上那个
 * 红星**也接了进来，因为它和另外三处说的是相反的话：
 *
 *   源端口标着红星「必填」，而新建时留空（0）本来就合法 —— 面板会随机分配，
 *   服务端两条路都支持。用户以为必须自己挑个号，猜一个，撞上占用，再猜一个。
 *   这个字段他本来可以完全不管。
 *
 * 另一头同样对不上：端口填成 70000 时按钮仍然亮着，点下去才弹 toast，而别的缺口
 * 都是按钮灰着、footer 说明缺什么。同一张表里两套反馈方式。
 *
 * 所以这一组盯的是这两条的对应关系本身：**没标红星的字段不许拦，标了的必须拦**。
 */

const base: ForwardRuleFormState = {
  routeMode: "local",
  tunnelId: null,
  forwardGroupId: 7,
  hostId: null,
  sourcePort: 0,
  targetIp: "10.0.0.1",
  targetPort: 80,
  protocol: "tcp",
  failoverEnabled: false,
};

const context = (overrides: Partial<ForwardRuleFormContext> = {}): ForwardRuleFormContext => ({
  editing: false,
  usesForwardGroup: true,
  canUseLocalForward: true,
  canUseForwardChain: true,
  canUseFailoverGroup: true,
  canUseGost: true,
  portStatus: "idle",
  ...overrides,
});

test("新建时源端口留空是合法的，不许拦，也不该标必填", () => {
  assert.equal(isForwardRuleSourcePortRequired(context()), false);
  assert.equal(
    forwardRuleFormBlocker({ ...base, sourcePort: 0 }, context()),
    null,
    "源端口 0 = 让面板随机分配，服务端两条路都支持。拦住它等于逼用户去猜一个号。",
  );
});

test("编辑时源端口不能留空 —— 标必填，也真的拦", () => {
  const editing = context({ editing: true });
  assert.equal(isForwardRuleSourcePortRequired(editing), true);
  assert.equal(
    forwardRuleFormBlocker({ ...base, sourcePort: 0 }, editing),
    "源端口必须在 1-65535 之间",
    "这条规则已经占着一个端口在跑，改成 0 意思不明 —— 与其猜，不如让人把号写出来",
  );
});

test("端口越界时按钮就该灰着，而不是点了才弹提示", () => {
  for (const [form, expected] of [
    [{ ...base, sourcePort: 70000 }, "源端口必须为 0 或 1-65535，0 表示随机分配"],
    [{ ...base, targetPort: 70000 }, "目标端口必须在 1-65535 之间"],
    [{ ...base, sourcePort: -1 }, "源端口必须为 0 或 1-65535，0 表示随机分配"],
  ] as const) {
    assert.equal(
      forwardRuleFormBlocker(form, context()),
      expected,
      `${JSON.stringify(form)} 应当被拦下 —— 越界的端口不该让按钮亮着`,
    );
  }
});

test("缺口按填表顺序只报第一个", () => {
  // 一次列三条缺失反而没人读；顺序是线路 → 源端口 → 目标 → 出站策略。
  assert.equal(forwardRuleFormBlocker({ ...base, forwardGroupId: null }, context()), "还没选端口转发");
  assert.equal(forwardRuleFormBlocker({ ...base, routeMode: "chain", forwardGroupId: null }, context()), "还没选转发链");
  assert.equal(forwardRuleFormBlocker({ ...base, routeMode: "tunnel", tunnelId: null }, context()), "还没选隧道");
  assert.equal(
    forwardRuleFormBlocker({ ...base, targetIp: "", targetPort: 0 }, context({ portStatus: "used" })),
    "源端口已被占用",
    "端口占用排在目标地址前面 —— 用户是照着这个顺序填的",
  );
  assert.equal(forwardRuleFormBlocker({ ...base, targetIp: "" }, context()), "还缺目标地址");
  assert.equal(forwardRuleFormBlocker({ ...base, targetPort: 0 }, context()), "还缺目标端口");
});

test("自己挑主机那条路要选线路，用转发组那条路不要", () => {
  assert.equal(
    forwardRuleFormBlocker({ ...base, forwardGroupId: null, hostId: null }, context({ usesForwardGroup: false })),
    "还没选线路",
  );
  assert.equal(
    forwardRuleFormBlocker({ ...base, forwardGroupId: null, hostId: 3 }, context({ usesForwardGroup: false })),
    null,
  );
});

test("出站策略只支持 TCP", () => {
  assert.equal(
    forwardRuleFormBlocker({ ...base, failoverEnabled: true, protocol: "udp" }, context()),
    "出站策略只支持 TCP",
  );
  assert.equal(forwardRuleFormBlocker({ ...base, failoverEnabled: true, protocol: "tcp" }, context()), null);
});

test("端口合法性只有一处定义", () => {
  assert.equal(isValidForwardPort(0), false);
  assert.equal(isValidForwardPort(0, true), true);
  assert.equal(isValidForwardPort(65535), true);
  assert.equal(isValidForwardPort(65536), false);
  assert.equal(isValidForwardPort(1.5), false);
  assert.equal(isValidForwardPort("80"), true, "表单里拿到的是字符串转出来的数，别在这儿挑剔类型");
});
