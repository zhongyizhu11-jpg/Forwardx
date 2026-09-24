import assert from "node:assert/strict";
import test from "node:test";
import { describeFailoverLines, failoverLineHintText, type RelayCandidate } from "./failoverRelayHints";
import { formatFailoverEndpoint, parseFailoverTargetLine } from "@shared/failoverTargets";

/**
 * 备用线路那几行，面板得认得出它们指向哪儿。
 *
 * 手填 `地址:端口` 时有三件事完全看不见，而任何一件出错都要等真出事那天才暴露：
 *
 *   · 这条出站到底是哪台中转的哪条规则（两个月后自己都不记得）；
 *   · 它的健康检查有没有盲区（用户态中转时探测只到中转本身，中转的上游断了
 *     不会切，流量继续往死路里送）；
 *   · 它和主线路是不是通向同一个落地（主备的前提就是这个，指错了等于切过去
 *     换了个服务）。
 *
 * 判断放在纯函数里就是为了能测 —— 这三条正是最该测的。
 */

const relayA: RelayCandidate = {
  id: 1, label: "香港→洛杉矶", hostName: "中转A", address: "203.0.113.1:20001",
  forwardType: "iptables", userspaceRelay: false, targetIp: "198.51.100.7", targetPort: 443,
};
const relayB: RelayCandidate = {
  id: 2, label: "东京→洛杉矶", hostName: "中转B", address: "203.0.113.2:20002",
  forwardType: "gost", userspaceRelay: true, targetIp: "198.51.100.7", targetPort: 443,
};
const relayWrong: RelayCandidate = {
  id: 3, label: "大阪→别处", hostName: "中转C", address: "203.0.113.3:20003",
  forwardType: "iptables", userspaceRelay: false, targetIp: "198.51.100.9", targetPort: 443,
};

function describe(text: string, mainAddress: string, candidates = [relayA, relayB, relayWrong]) {
  return describeFailoverLines({
    text,
    candidates,
    mainAddress,
    parseLine: parseFailoverTargetLine as any,
    formatEndpoint: formatFailoverEndpoint,
  });
}

test("认出每一行是面板里的哪条中转", () => {
  const hints = describe("203.0.113.1:20001\n203.0.113.2:20002", "198.51.100.7:443");
  assert.equal(hints.length, 2);
  assert.equal(hints[0].relay?.id, 1);
  assert.equal(hints[1].relay?.id, 2);
  assert.equal(hints[0].line, 1);
  assert.equal(hints[1].line, 2);
});

test("认不出来的地址就说认不出来，不要猜", () => {
  // 外部地址是合法用法（别人家的中转）。硬猜一个最像的中转出来，比什么都不说更糟。
  const hints = describe("198.51.100.200:443", "198.51.100.7:443");
  assert.equal(hints[0].relay, null);
  assert.equal(hints[0].sameDestination, null, "认不出中转就无从判断落地，不能瞎报「不一致」");
  assert.equal(failoverLineHintText(hints[0]), "", "没有可说的就别说 —— 不要为了整齐说废话");
});

test("用户态中转又没配探测目标 = 有盲区", () => {
  const hints = describe("203.0.113.2:20002", "198.51.100.7:443");
  assert.equal(hints[0].probeBlindSpot, true);
  assert.match(failoverLineHintText(hints[0]), /用户态转发/);
});

test("同一台用户态中转，配了探测目标就不再报盲区", () => {
  const hints = describe("203.0.113.2:20002  203.0.113.2:9000", "198.51.100.7:443");
  assert.equal(hints[0].hasProbe, true);
  assert.equal(hints[0].probeBlindSpot, false, "补上探测目标之后就不该再唠叨");
});

test("内核转发的中转不报盲区 —— 它的探测本来就是端到端的", () => {
  // iptables/nftables 是 DNAT：握手是和最终落地完成的，中转的上游断了立刻探得出来。
  const hints = describe("203.0.113.1:20001", "198.51.100.7:443");
  assert.equal(hints[0].probeBlindSpot, false);
});

test("备用线路通向别的落地要报出来", () => {
  const hints = describe("203.0.113.3:20003", "198.51.100.7:443");
  assert.equal(hints[0].sameDestination, false);
  assert.match(failoverLineHintText(hints[0]), /不是同一个落地/);
});

test("主线路自己是中转时，比的是它通向的落地，不是它的地址", () => {
  /*
    这正是用户要的形状：主走中转 A、备走中转 B，两条都到同一个落地。
    按字面地址比的话，203.0.113.1:20001 和 203.0.113.2:20002 当然不相等 ——
    会把一个配对的主备误报成「不是同一个落地」，而那是最该被信任的一条提示。
  */
  const hints = describe("203.0.113.2:20002", "203.0.113.1:20001");
  assert.equal(hints[0].sameDestination, true);
  assert.equal(hints[0].relay?.id, 2);

  const wrong = describe("203.0.113.3:20003", "203.0.113.1:20001");
  assert.equal(wrong[0].sameDestination, false, "主备各自通向不同落地时仍然要报");
});

test("空行和写错的行不占行号也不报错", () => {
  const hints = describe("\n203.0.113.1:20001\n\n坏地址\n203.0.113.2:20002", "198.51.100.7:443");
  assert.deepEqual(hints.map((hint) => hint.line), [2, 5], "行号要和输入框里看到的对得上");
});
