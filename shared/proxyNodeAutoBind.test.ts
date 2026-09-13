import assert from "node:assert/strict";
import test from "node:test";

import { matchProxyNodeForTarget, shouldAutoBindProxyNode } from "./proxyNodeAutoBind";

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
