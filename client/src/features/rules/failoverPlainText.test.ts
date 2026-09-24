import assert from "node:assert/strict";
import test from "node:test";

import {
  FAILOVER_STRATEGY_CHOICES,
  describeFailoverPlainly,
  failoverAddressError,
  failoverRowNumbers,
  failoverRowsOf,
  joinFailoverRow,
  splitFailoverRow,
  summarizeFailoverAdvanced,
} from "./failoverPlainText";

const base = { strategy: "fallback" as const, backupCount: 1, failoverSeconds: 60, recoverSeconds: 120, autoFailback: true };

test("主备：一句话说清楚平时走哪条、什么时候换、会不会切回来", () => {
  const text = describeFailoverPlainly(base);
  assert.match(text, /平时都走主线路/);
  assert.match(text, /新连接连不上，或连续 60 秒检查不通/, "两种判坏的方式都得说：新连接拨不通是当场就换的");
  assert.match(text, /就换到备用 1。/);
  assert.match(text, /主线路恢复后稳定 2 分钟，自动切回来/);
});

test("主备：多条备用说「再往下换」，关了切回说「不会自动切回」", () => {
  assert.match(describeFailoverPlainly({ ...base, backupCount: 3 }), /备用 1 也不行再往下换/);
  const noBack = describeFailoverPlainly({ ...base, autoFailback: false });
  assert.match(noBack, /不会自动切回主线路/);
  assert.doesNotMatch(noBack, /自动切回来/);
});

test("还没填备用线路时，不描述一个不存在的切换", () => {
  const text = describeFailoverPlainly({ ...base, backupCount: 0 });
  assert.match(text, /还没有备用线路/);
  assert.doesNotMatch(text, /换到备用/);
});

test("轮流、随机、按访客固定：各说各的，不套主备那句「平时都走主线路」", () => {
  const roundRobin = describeFailoverPlainly({ ...base, strategy: "round_robin", backupCount: 2 });
  assert.match(roundRobin, /轮流走主线路和 2 条备用/);
  const random = describeFailoverPlainly({ ...base, strategy: "random", backupCount: 2 });
  assert.match(random, /随机挑一条/);
  const hash = describeFailoverPlainly({ ...base, strategy: "ip_hash", backupCount: 2 });
  assert.match(hash, /同一个访客（来源 IP）总走同一条线路/);
  for (const text of [roundRobin, random, hash]) assert.doesNotMatch(text, /平时都走主线路/);
});

test("分配方式的选项上不写「IP 哈希」这种实现名词，主备标着推荐", () => {
  const labels = FAILOVER_STRATEGY_CHOICES.map((choice) => choice.label).join(" ");
  assert.doesNotMatch(labels, /哈希|hash/i);
  assert.equal(FAILOVER_STRATEGY_CHOICES[0].value, "fallback");
  assert.match(FAILOVER_STRATEGY_CHOICES[0].label, /推荐/);
});

test("高级设置的摘要只列改过默认值的项：全默认就是空的", () => {
  const defaults = {
    strategy: "fallback" as const,
    failoverSeconds: 60,
    recoverSeconds: 120,
    failoverMinHoldSeconds: 0,
    autoFailback: true,
    failoverProbeTarget: "",
    hasLineProbe: false,
    scheduleWindows: 0,
    pinned: false,
    preferFastest: false,
  };
  assert.deepEqual(summarizeFailoverAdvanced(defaults), []);
  assert.deepEqual(
    summarizeFailoverAdvanced({ ...defaults, scheduleWindows: 2, preferFastest: true, failoverSeconds: 30, autoFailback: false, hasLineProbe: true }),
    ["时段表 2 段", "自动择优", "挂了 30 秒就切", "不自动切回", "自定探测地址"],
  );
  // 轮询这类没有首选：时段表、择优、最短驻留、切回都不适用，就不在摘要里冒出来。
  assert.deepEqual(
    summarizeFailoverAdvanced({ ...defaults, strategy: "round_robin", scheduleWindows: 1, preferFastest: true, autoFailback: false, failoverMinHoldSeconds: 30 }),
    ["分配：轮流"],
  );
});

test("一行拆成地址和探测地址，拼回去和原来一样", () => {
  assert.deepEqual(splitFailoverRow("10.0.0.2:80  10.0.0.2:9000"), { address: "10.0.0.2:80", probe: "10.0.0.2:9000" });
  assert.deepEqual(splitFailoverRow(""), { address: "", probe: "" });
  assert.equal(joinFailoverRow({ address: "10.0.0.2:80", probe: "10.0.0.2:9000" }), "10.0.0.2:80 10.0.0.2:9000");
  assert.equal(joinFailoverRow({ address: "10.0.0.2:80", probe: " " }), "10.0.0.2:80");
  assert.equal(joinFailoverRow({ address: "", probe: "10.0.0.2:9000" }), "", "只剩探测地址时，下次拆开它会被当成地址");
});

test("空文本也给一个空框；编号按前面填好的条数数，空行占的是下一条的位置", () => {
  assert.deepEqual(failoverRowsOf(""), [""]);
  assert.deepEqual(failoverRowsOf("a:1\nb:2"), ["a:1", "b:2"]);
  assert.deepEqual(failoverRowNumbers(["a:1", "", "b:2", ""]), [1, 2, 2, 3]);
});

test("每一格地址当场说哪里不对，空着和填对了都不吭声", () => {
  assert.equal(failoverAddressError(""), null);
  assert.equal(failoverAddressError("10.0.0.2:443"), null);
  assert.equal(failoverAddressError("example.com:8443"), null);
  assert.match(failoverAddressError("10.0.0.2") || "", /地址:端口/);
  assert.match(failoverAddressError("10.0.0.2:70000") || "", /1–65535/);
  assert.match(failoverAddressError("bad host!:80") || "", /地址格式不对/);
});
