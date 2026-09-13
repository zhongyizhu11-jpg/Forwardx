import assert from "node:assert/strict";
import test from "node:test";

import {
  matchProxyNodeForTarget,
  planProxyNodeBinding,
  proxyNodeBindingTruth,
  rulesMatchingProxyNode,
  shouldAutoBindProxyNode,
} from "./proxyNodeAutoBind";

/**
 * 认错的后果是把**别人的线路**塞进订阅 —— 客户端里那条中转指向一台不该指的落地机。
 * 所以这一组几乎全在写「什么情况下宁可不认」。
 */
const nodes = [
  { id: 1, address: "hk.example.com", port: 443, isEnabled: true },
  { id: 2, address: "1.2.3.4", port: 8443, isEnabled: true },
  { id: 3, address: "off.example.com", port: 443, isEnabled: false },
  { id: 4, address: "shared.example.com", port: 443, isEnabled: true, sharedFrom: true },
];

test("目标地址端口完全对上才认", () => {
  assert.equal(matchProxyNodeForTarget(nodes, "hk.example.com", 443)?.id, 1);
  assert.equal(matchProxyNodeForTarget(nodes, "1.2.3.4", 8443)?.id, 2);
  // 端口不同就是另一回事，地址像也不认。
  assert.equal(matchProxyNodeForTarget(nodes, "hk.example.com", 8443), null);
  assert.equal(matchProxyNodeForTarget(nodes, "hk.example.com.cn", 443), null);
});

test("大小写与 IPv6 方括号不该影响判断", () => {
  assert.equal(matchProxyNodeForTarget(nodes, "HK.Example.COM", 443)?.id, 1);
  const v6 = [{ id: 9, address: "2001:db8::1", port: 443, isEnabled: true }];
  // 转发那边可能带方括号，节点那边不一定带。
  assert.equal(matchProxyNodeForTarget(v6, "[2001:db8::1]", 443)?.id, 9);
});

test("停用的节点不认 —— 它本来就不该出现在订阅里", () => {
  assert.equal(matchProxyNodeForTarget(nodes, "off.example.com", 443), null);
});

test("认出多个就一个都不认", () => {
  const ambiguous = [
    { id: 1, address: "hk.example.com", port: 443, isEnabled: true },
    { id: 2, address: "hk.example.com", port: 443, isEnabled: true },
  ];
  // 猜错一次就是订阅里指向了错的落地机，不如让人自己选。
  assert.equal(matchProxyNodeForTarget(ambiguous, "hk.example.com", 443), null);
});

test("自己的节点优先于别人分享来的", () => {
  const both = [
    { id: 4, address: "shared.example.com", port: 443, isEnabled: true, sharedFrom: true },
    { id: 5, address: "shared.example.com", port: 443, isEnabled: true },
  ];
  assert.equal(matchProxyNodeForTarget(both, "shared.example.com", 443)?.id, 5);
  // 只有分享来的那条时，认它。
  assert.equal(matchProxyNodeForTarget(nodes, "shared.example.com", 443)?.id, 4);
});

test("空地址、非法端口一律不认", () => {
  assert.equal(matchProxyNodeForTarget(nodes, "", 443), null);
  assert.equal(matchProxyNodeForTarget(nodes, "hk.example.com", 0), null);
  assert.equal(matchProxyNodeForTarget(nodes, "hk.example.com", "abc"), null);
  assert.equal(matchProxyNodeForTarget([], "hk.example.com", 443), null);
});

test("只在新建、或改了目标之后仍没绑定时才自动绑", () => {
  assert.equal(shouldAutoBindProxyNode({ isCreate: true }), true);
  assert.equal(shouldAutoBindProxyNode({ isCreate: false, targetChanged: true }), true);
  /**
   * 目标没变就不再自作主张 —— 手动解绑过的人不会顺手改目标，每次保存都认一遍
   * 等于「他解绑了，面板又给他绑回去」。
   */
  assert.equal(shouldAutoBindProxyNode({ isCreate: false, targetChanged: false }), false);
  assert.equal(shouldAutoBindProxyNode({ isCreate: false }), false);
  // 已经明确指定了节点的，更不能动。
  assert.equal(shouldAutoBindProxyNode({ isCreate: true, boundNodeId: 7 }), false);
  assert.equal(shouldAutoBindProxyNode({ isCreate: false, targetChanged: true, boundNodeId: 7 }), false);
});

test("反过来：新建节点时认出已经指向它的转发", () => {
  const rules = [
    { id: 1, targetIp: "hk.example.com", targetPort: 443, proxyNodeId: 0 },
    { id: 2, targetIp: "HK.example.com", targetPort: 443, proxyNodeId: 0 },  // 大小写不影响
    { id: 3, targetIp: "hk.example.com", targetPort: 8443, proxyNodeId: 0 }, // 端口不同
    { id: 4, targetIp: "hk.example.com", targetPort: 443, proxyNodeId: 9 },  // 已经绑了别的
    { id: 5, targetIp: "other.example.com", targetPort: 443, proxyNodeId: 0 },
  ];
  const matched = rulesMatchingProxyNode(rules, { address: "hk.example.com", port: 443 });
  assert.deepEqual(matched.map((rule) => rule.id), [1, 2]);
});

test("反向匹配同样不猜：地址或端口不成立就是空", () => {
  const rules = [{ id: 1, targetIp: "hk.example.com", targetPort: 443, proxyNodeId: 0 }];
  assert.deepEqual(rulesMatchingProxyNode(rules, { address: "", port: 443 }), []);
  assert.deepEqual(rulesMatchingProxyNode(rules, { address: "hk.example.com", port: 0 }), []);
  assert.deepEqual(rulesMatchingProxyNode([], { address: "hk.example.com", port: 443 }), []);
});

/**
 * 绑定是否还成立。判错的两个方向都有代价：
 * 判成坏的 → 好好的线路被标成有问题；判成好的 → 客户端把落地的凭据递给别的机器。
 */

test("目标就是这个节点：成立", () => {
  assert.equal(
    proxyNodeBindingTruth({ targetIp: "198.51.100.5", targetPort: 443 }, { address: "198.51.100.5", port: 443 }),
    "matches",
  );
  // IPv6 带方括号是转发那边的写法，节点那边不一定带。
  assert.equal(
    proxyNodeBindingTruth({ targetIp: "[2001:db8::1]", targetPort: 443 }, { address: "2001:db8::1", port: 443 }),
    "matches",
  );
});

test("端口不一样一定不通 —— 中转要成立，目标端口就得是节点监听的端口", () => {
  assert.equal(
    proxyNodeBindingTruth({ targetIp: "198.51.100.5", targetPort: 8443 }, { address: "198.51.100.5", port: 443 }),
    "mismatch",
  );
});

test("两边都是 IP 且不同：一定不是同一台机器", () => {
  assert.equal(
    proxyNodeBindingTruth({ targetIp: "203.0.113.250", targetPort: 443 }, { address: "198.51.100.5", port: 443 }),
    "mismatch",
  );
});

test("有一边是域名就不下结论 —— 同一台机器可以一边写 IP 一边写 DDNS 域名", () => {
  assert.equal(
    proxyNodeBindingTruth({ targetIp: "198.51.100.5", targetPort: 443 }, { address: "node.example.com", port: 443 }),
    "unknown",
  );
  assert.equal(
    proxyNodeBindingTruth({ targetIp: "a.example.com", targetPort: 443 }, { address: "b.example.com", port: 443 }),
    "unknown",
  );
});

test("字段缺了也不下结论", () => {
  assert.equal(proxyNodeBindingTruth({}, { address: "198.51.100.5", port: 443 }), "unknown");
  assert.equal(proxyNodeBindingTruth({ targetIp: "198.51.100.5", targetPort: 0 }, { address: "198.51.100.5", port: 443 }), "unknown");
  assert.equal(proxyNodeBindingTruth({ targetIp: "198.51.100.5", targetPort: 443 }, {}), "unknown");
});

/**
 * 保存之后绑定怎么动。判错的两个方向：把一条好线路解掉（客户端里线路消失），
 * 或者留着一条把落地凭据递给别人的线路。
 */
const twoNodes = [
  { id: 1, address: "198.51.100.5", port: 443 },
  { id: 2, address: "198.51.100.9", port: 443 },
];

test("没绑过的按原规矩认一次", () => {
  assert.deepEqual(
    planProxyNodeBinding({
      isCreate: true,
      nextTarget: { targetIp: "198.51.100.5", targetPort: 443 },
      candidates: twoNodes,
    }),
    { action: "bind", nodeId: 1 },
  );
  // 目标没变、又不是新建：不认。
  assert.deepEqual(
    planProxyNodeBinding({
      isCreate: false,
      nextTarget: { targetIp: "198.51.100.5", targetPort: 443 },
      candidates: twoNodes,
    }),
    { action: "none" },
  );
});

test("改到另一个节点上就改绑", () => {
  assert.deepEqual(
    planProxyNodeBinding({
      isCreate: false,
      targetChanged: true,
      boundNodeId: 1,
      boundNodePlace: { address: "198.51.100.5", port: 443 },
      previousTarget: { targetIp: "198.51.100.5", targetPort: 443 },
      nextTarget: { targetIp: "198.51.100.9", targetPort: 443 },
      candidates: twoNodes,
    }),
    { action: "rebind", nodeId: 2 },
  );
});

test("改到谁都不是的地方就解绑 —— 否则订阅里那条会把落地凭据递给新目标", () => {
  assert.deepEqual(
    planProxyNodeBinding({
      isCreate: false,
      targetChanged: true,
      boundNodeId: 1,
      boundNodePlace: { address: "198.51.100.5", port: 443 },
      previousTarget: { targetIp: "198.51.100.5", targetPort: 443 },
      nextTarget: { targetIp: "203.0.113.250", targetPort: 8443 },
      candidates: twoNodes,
    }),
    { action: "release" },
  );
});

test("原来就不是字面相符的，一个字都不动", () => {
  // 串两跳：这条转发的目标是另一条转发的入口，绑定挂在这条上。不是我们能判的。
  assert.deepEqual(
    planProxyNodeBinding({
      isCreate: false,
      targetChanged: true,
      boundNodeId: 1,
      boundNodePlace: { address: "198.51.100.5", port: 443 },
      previousTarget: { targetIp: "203.0.113.10", targetPort: 20001 },
      nextTarget: { targetIp: "203.0.113.10", targetPort: 20002 },
      candidates: twoNodes,
    }),
    { action: "none" },
  );
});

test("目标只是换了个写法、仍然指着同一处：不动", () => {
  assert.deepEqual(
    planProxyNodeBinding({
      isCreate: false,
      targetChanged: true,
      boundNodeId: 1,
      boundNodePlace: { address: "198.51.100.5", port: 443 },
      previousTarget: { targetIp: "198.51.100.5", targetPort: 443 },
      nextTarget: { targetIp: "198.51.100.5", targetPort: 443 },
      candidates: twoNodes,
    }),
    { action: "none" },
  );
});

test("绑的节点已经不在了：不掺和，那是删除流程的事", () => {
  assert.deepEqual(
    planProxyNodeBinding({
      isCreate: false,
      targetChanged: true,
      boundNodeId: 7,
      boundNodePlace: null,
      previousTarget: { targetIp: "198.51.100.5", targetPort: 443 },
      nextTarget: { targetIp: "203.0.113.250", targetPort: 8443 },
      candidates: twoNodes,
    }),
    { action: "none" },
  );
});

test("解绑之后再改回来还能自己认回去", () => {
  assert.deepEqual(
    planProxyNodeBinding({
      isCreate: false,
      targetChanged: true,
      boundNodeId: 0,
      previousTarget: { targetIp: "203.0.113.250", targetPort: 8443 },
      nextTarget: { targetIp: "198.51.100.5", targetPort: 443 },
      candidates: twoNodes,
    }),
    { action: "bind", nodeId: 1 },
  );
});
