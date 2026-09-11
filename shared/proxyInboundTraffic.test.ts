import assert from "node:assert/strict";
import test from "node:test";

import {
  isProxyInboundTrafficRuleId,
  proxyInboundIdFromTrafficRuleId,
  proxyInboundTrafficProtocol,
  proxyInboundTrafficRuleId,
  PROXY_INBOUND_TRAFFIC_FORWARD_TYPE,
  PROXY_INBOUND_TRAFFIC_RULE_ID_BASE,
} from "./proxyInboundTraffic";
import { countingRuleModeForForwardType } from "../server/agentActionCommands";

test("入站 id 与上报 ruleId 之间来回换算不丢", () => {
  for (const id of [1, 2, 77, 12_345, PROXY_INBOUND_TRAFFIC_RULE_ID_BASE - 1]) {
    const ruleId = proxyInboundTrafficRuleId(id);
    assert.equal(isProxyInboundTrafficRuleId(ruleId), true, String(id));
    assert.equal(proxyInboundIdFromTrafficRuleId(ruleId), id, String(id));
  }
});

test("真实转发规则的 id 不会被误认成入站", () => {
  // 撞上就意味着把落地流量算到某条转发规则头上，或者反过来 —— 都是记错账。
  for (const ruleId of [1, 2, 999, 1_000_000, PROXY_INBOUND_TRAFFIC_RULE_ID_BASE]) {
    assert.equal(isProxyInboundTrafficRuleId(ruleId), false, String(ruleId));
    assert.equal(proxyInboundIdFromTrafficRuleId(ruleId), 0, String(ruleId));
  }
});

test("编码结果仍在 int32 范围内", () => {
  // Agent 侧 ruleId 是 Go 的 int，JSON 过一遭；超出 int32 在 32 位构建上会翻车。
  const max = proxyInboundTrafficRuleId(PROXY_INBOUND_TRAFFIC_RULE_ID_BASE - 1);
  assert.ok(max < 2_147_483_647, `${max} 超出 int32`);
});

test("不合法的入站 id 当场报错，而不是编出一个会记错账的 ruleId", () => {
  for (const bad of [0, -1, 1.5, PROXY_INBOUND_TRAFFIC_RULE_ID_BASE]) {
    assert.throws(() => proxyInboundTrafficRuleId(bad), /不合法|超出可编码范围/, String(bad));
  }
});

test("落地端口用的转发方式落在「只计数」那一档", () => {
  /**
   * 这一条是整个方案的支点：countingRuleProcess 模式装计数链只需要监听端口和
   * 协议，不需要目标地址；而 runningRules 只驱动装计数链，转发器是 actions 起的。
   * 所以这个转发方式一旦被归成 kernel，Agent 会因为「目标解析不出来」而拒绝装链，
   * 落地流量就一个字节都记不上。
   */
  assert.equal(countingRuleModeForForwardType(PROXY_INBOUND_TRAFFIC_FORWARD_TYPE), "process");
  // 反过来确认那几个会走别的分支的名字没被误用。
  assert.equal(countingRuleModeForForwardType("iptables"), "kernel");
  assert.equal(countingRuleModeForForwardType("nftables"), "none");
  assert.equal(countingRuleModeForForwardType("forwardx"), "none");
});

test("QUIC 系协议按 udp 计数，其余按 tcp", () => {
  // 算错的后果是漏计一半流量：Hysteria2/TUIC 全程只有 UDP 包，
  // 而其余协议的 UDP 转发裹在 TCP 流里，按 tcp 算就是全量。
  assert.equal(proxyInboundTrafficProtocol("hysteria2"), "udp");
  assert.equal(proxyInboundTrafficProtocol("tuic"), "udp");
  for (const protocol of ["vless", "vmess", "trojan", "shadowsocks", "anytls", "snell"]) {
    assert.equal(proxyInboundTrafficProtocol(protocol), "tcp", protocol);
  }
  assert.equal(proxyInboundTrafficProtocol(undefined), "tcp");
});
