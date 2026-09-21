import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_FAILOVER_TARGETS,
  failoverProbeEndpoint,
  formatFailoverEndpoint,
  formatFailoverTargetLine,
  parseFailoverEndpoint,
  parseFailoverTargetLine,
  parseFailoverTargets,
} from "./failoverTargets";

/**
 * 主备出站的文本语法与健康探测目标。
 *
 * 探测目标解决的是一个界面上完全看不出来的盲区：Agent 的健康检查就是对出站地址连
 * 一次 TCP。出站是 iptables/DNAT 类中转时，握手实际是和最终落地完成的，这一连就是
 * 端到端的；出站是 gost、realm 这类用户态转发时，中转在本地就把连接收下了 —— 连得上
 * 只能证明中转活着。
 *
 * 后一种情况下中转的上游断了，主备**不会切**：流量继续往一条死路里送，而面板上一切
 * 正常。用户的体感是「备用线路配了，关键时刻没兜住」，而且查不出为什么。
 *
 * 语法与解析必须客户端服务端共用一份 —— 两边对「什么算合法」的理解一旦分家，
 * 用户会看到「面板收下了，机器上没生效」，而这是兜底功能，最不该这么坏。
 */

test("一行一个出站，第二个地址是选填的探测目标", () => {
  assert.deepEqual(parseFailoverTargetLine("10.0.0.1:80"), { targetIp: "10.0.0.1", targetPort: 80 });
  assert.deepEqual(parseFailoverTargetLine("10.0.0.2:80  10.0.0.2:9000"), {
    targetIp: "10.0.0.2", targetPort: 80, probeIp: "10.0.0.2", probePort: 9000,
  });
  assert.deepEqual(parseFailoverTargetLine("  "), null);
});

test("IPv6 必须带方括号，写错了要说清楚", () => {
  assert.deepEqual(parseFailoverTargetLine("[2001:db8::1]:443"), { targetIp: "2001:db8::1", targetPort: 443 });
  assert.deepEqual(parseFailoverTargetLine("[2001:db8::1]:443 [2001:db8::2]:9000"), {
    targetIp: "2001:db8::1", targetPort: 443, probeIp: "2001:db8::2", probePort: 9000,
  });
  // `::1:80` 分不清哪段是端口，猜一个出来比报错更糟。
  assert.deepEqual(parseFailoverTargetLine("[2001:db8::1:443"), { error: "IPv6 地址请使用 [地址]:端口 格式" });
});

test("多写一个地址要报错，不能默默吃掉", () => {
  /*
    吃掉的那一个正是用户以为已经生效的东西 —— 他填了探测目标、面板收下了、
    机器上没有，而盲区还在。
  */
  assert.deepEqual(parseFailoverTargetLine("10.0.0.1:80 10.0.0.1:9000 10.0.0.1:9001"), {
    error: "一行最多写「出站地址 探测地址」两个地址",
  });
  assert.deepEqual(parseFailoverTargetLine("10.0.0.1:80 坏地址"), { error: "探测地址：请按 地址:端口 格式填写" });
});

test("写回文本框和读进来是一对反函数", () => {
  for (const line of ["10.0.0.1:80", "10.0.0.2:80 10.0.0.2:9000", "[2001:db8::1]:443", "[2001:db8::1]:443 [2001:db8::2]:9000"]) {
    const parsed = parseFailoverTargetLine(line);
    assert.ok(parsed && !("error" in parsed), `${line} 没解析出来`);
    assert.equal(formatFailoverTargetLine(parsed), line.replace(/\s+/g, " "),
      "解析再写回必须还是同一行，否则用户每打开一次编辑框，内容就变一次");
  }
});

test("没填探测目标就探出站地址本身 —— 也就是老行为", () => {
  assert.deepEqual(failoverProbeEndpoint({ targetIp: "10.0.0.1", targetPort: 80 }), { host: "10.0.0.1", port: 80 });
  assert.deepEqual(
    failoverProbeEndpoint({ targetIp: "10.0.0.1", targetPort: 80, probeIp: "10.0.0.1", probePort: 9000 }),
    { host: "10.0.0.1", port: 9000 },
  );
  // 探测目标填得不合法时退回探自己：不能因为一个填错的地址，
  // 就让这条出站永远探不通、被当成挂了。
  assert.deepEqual(
    failoverProbeEndpoint({ targetIp: "10.0.0.1", targetPort: 80, probeIp: "", probePort: 70000 }),
    { host: "10.0.0.1", port: 80 },
  );
});

test("存进库的 JSON 带着探测目标读得回来", () => {
  const stored = JSON.stringify([
    { targetIp: "10.0.0.1", targetPort: 80 },
    { targetIp: "10.0.0.2", targetPort: 80, probeIp: "10.0.0.2", probePort: 9000 },
    { targetIp: "", targetPort: 80 },
    { targetIp: "10.0.0.3", targetPort: 0 },
  ]);
  assert.deepEqual(parseFailoverTargets(stored), [
    { targetIp: "10.0.0.1", targetPort: 80 },
    { targetIp: "10.0.0.2", targetPort: 80, probeIp: "10.0.0.2", probePort: 9000 },
  ]);
  assert.deepEqual(parseFailoverTargets("不是 JSON"), []);
  assert.deepEqual(parseFailoverTargets(null), []);
});

test("上限只有一个数，面板和下发读的是同一个", () => {
  /*
    原来面板用 MAX_FAILOVER_TARGETS、心跳那份写死 10。两个数当时碰巧相等所以没出事，
    但调大之后面板会收下 15 个、Agent 只拿到 10 个 —— 剩下 5 个不报错、不提示、
    只是永远不生效。兜底本身悄悄少一半，是最不该发生的那种坏法。
  */
  const many = JSON.stringify(
    Array.from({ length: MAX_FAILOVER_TARGETS + 5 }, (_, index) => ({ targetIp: `10.0.0.${index + 1}`, targetPort: 80 })),
  );
  assert.equal(parseFailoverTargets(many).length, MAX_FAILOVER_TARGETS);
});

test("地址格式化：IPv6 加方括号，其余原样", () => {
  assert.equal(formatFailoverEndpoint("10.0.0.1", 80), "10.0.0.1:80");
  assert.equal(formatFailoverEndpoint("2001:db8::1", 443), "[2001:db8::1]:443");
  assert.equal(formatFailoverEndpoint("", 443), "");
  assert.deepEqual(parseFailoverEndpoint(""), null);
});
