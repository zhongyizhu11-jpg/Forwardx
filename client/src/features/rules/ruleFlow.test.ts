import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRuleFlow,
  buildRuleFormPreview,
  decideRuleFlowLayout,
  ruleVisualStateToHealth,
} from "./ruleFlow";

test("直连走一行，隧道/链/组走竖排 Flow", () => {
  /*
    版式跟着数据走：直连的入口和目标之间什么都没有，画五行去说「A 转到 B」
    只是在重复箭头；隧道的中间那一段才是它和直连的唯一区别。
  */
  assert.equal(decideRuleFlowLayout("local"), "inline");
  assert.equal(decideRuleFlowLayout("tunnel"), "flow");
  assert.equal(decideRuleFlowLayout("chain"), "flow");
  assert.equal(decideRuleFlowLayout("group"), "flow");
});

test("认不出来的分类按直连处理，不是崩掉也不是画成 Flow", () => {
  // 一行永远放得下，Flow 在没有中间节点时反而更糟。
  assert.equal(decideRuleFlowLayout(null), "inline");
  assert.equal(decideRuleFlowLayout("nonsense"), "inline");
});

test("Flow 的首尾带「入口/目标」注脚，中间的跳点不带", () => {
  /*
    这里和链路卡不一样：链路卡一整列都是主机名，位置足以区分；这里第一个和
    最后一个是地址、中间是主机名，两种东西混在一列里，不标一下会读成
    「三台机器」。
  */
  const flow = buildRuleFlow({
    entry: "42.194.198.67:22222",
    target: "217.116.172.44:22222",
    hops: ["Po0", "Jinx"],
  });
  assert.deepEqual(flow.nodes.map((n) => n.name), [
    "42.194.198.67:22222",
    "Po0",
    "Jinx",
    "217.116.172.44:22222",
  ]);
  assert.equal(flow.nodes[0].sublabel, "入口");
  assert.equal(flow.nodes[flow.nodes.length - 1].sublabel, "目标");
  assert.equal(flow.nodes[1].sublabel, undefined);
  assert.equal(flow.nodes[2].sublabel, undefined);
});

test("via 和延迟只标在中间那一段", () => {
  const flow = buildRuleFlow({
    entry: "a:1",
    target: "b:2",
    hops: ["Po0", "Jinx"],
    via: "ForwardX V2",
    latencyMs: 8,
  });
  const labelled = flow.edges.filter((e) => e.via || e.latencyMs != null);
  assert.equal(labelled.length, 1);
  assert.equal(labelled[0].via, "ForwardX V2");
  assert.equal(labelled[0].latencyMs, 8);
});

test("一段线的状态取两端里更该被注意的那个", () => {
  // 线不携带独立的探测数据，它能说的只有「它连的那两个点怎么样」。
  const flow = buildRuleFlow({ entry: "a:1", target: "b:2", hops: ["Po0"], health: "down" });
  assert.ok(flow.edges.every((e) => e.health === "down"));
});

test("没传 health 时是 unknown，不是 healthy", () => {
  const flow = buildRuleFlow({ entry: "a:1", target: "b:2", hops: ["Po0"] });
  assert.ok(flow.nodes.every((n) => n.health === "unknown"));
});

test("边比节点少一条", () => {
  const flow = buildRuleFlow({ entry: "a:1", target: "b:2", hops: ["x", "y", "z"] });
  assert.equal(flow.edges.length, flow.nodes.length - 1);
});

test("没有跳点时仍然是入口和目标两个节点", () => {
  // Flow 版式在分类判断之后才会用到，但函数本身不该在这种输入上垮掉。
  const flow = buildRuleFlow({ entry: "a:1", target: "b:2" });
  assert.equal(flow.nodes.length, 2);
  assert.equal(flow.edges.length, 1);
});

test("空白的跳点名被丢掉，不画成一个没名字的点", () => {
  const flow = buildRuleFlow({ entry: "a:1", target: "b:2", hops: ["Po0", "  ", ""] });
  assert.deepEqual(flow.nodes.map((n) => n.name), ["a:1", "Po0", "b:2"]);
});

test("入口或目标缺失时不画空节点", () => {
  const flow = buildRuleFlow({ entry: "", target: "b:2", hops: ["Po0"] });
  assert.deepEqual(flow.nodes.map((n) => n.name), ["Po0", "b:2"]);
});

test("title 带完整链路和延迟，窄屏截断时还读得到", () => {
  const flow = buildRuleFlow({
    entry: "42.194.198.67:22222",
    target: "217.116.172.44:22222",
    hops: ["Po0", "Jinx"],
    via: "ForwardX V2",
    latencyMs: 8,
  });
  assert.match(flow.title, /42\.194\.198\.67:22222 → Po0 → Jinx → 217\.116\.172\.44:22222/);
  assert.match(flow.title, /ForwardX V2/);
  assert.match(flow.title, /8 ms/);
});

test("规则状态四档映射到词汇表，pending 是 unknown 不是 degraded", () => {
  /*
    「等待 Agent 确认」说的是还没有结论，不是「有结论，结论是不太好」。
    画成琥珀会让人去查一个并不存在的问题。
  */
  assert.equal(ruleVisualStateToHealth("running"), "healthy");
  assert.equal(ruleVisualStateToHealth("error"), "down");
  assert.equal(ruleVisualStateToHealth("disabled"), "standby");
  assert.equal(ruleVisualStateToHealth("pending"), "unknown");
  assert.notEqual(ruleVisualStateToHealth("pending"), "degraded");
});

test("认不出来的状态回 unknown，不回 healthy", () => {
  assert.equal(ruleVisualStateToHealth(""), "unknown");
  assert.equal(ruleVisualStateToHealth(null), "unknown");
  assert.equal(ruleVisualStateToHealth("nonsense"), "unknown");
});

test("预览把没填的那一节画成待填写，不替用户补上", () => {
  /*
    预览最容易做坏的地方是替用户把没填的补上：目标还没填就先画一个「目标」，
    看起来这条转发已经成立了 —— 然后他点创建，被告诉缺目标地址。

    预览的职责是「你现在配出来的是这个」，不是「你大概想配这个」。
  */
  const preview = buildRuleFormPreview({ category: "local", entry: "1.2.3.4:80" });
  assert.deepEqual(preview.nodes.map((n) => n.name), ["1.2.3.4:80", "待填写"]);
  assert.equal(preview.nodes[1].health, "unknown");
  assert.equal(preview.nodes[0].health, "healthy");
});

test("选了走隧道但还没选哪条时，中间那一节是「待选择线路」", () => {
  // 这一节确实存在，只是还不知道是谁 —— 不画的话预览会看起来像直连。
  const preview = buildRuleFormPreview({ category: "tunnel", entry: "a:1", target: "b:2" });
  assert.deepEqual(preview.nodes.map((n) => n.name), ["a:1", "待选择线路", "b:2"]);
  assert.equal(preview.nodes[1].health, "unknown");
});

test("直连的预览没有中间节点", () => {
  const preview = buildRuleFormPreview({ category: "local", entry: "a:1", target: "b:2" });
  assert.equal(preview.nodes.length, 2);
});

test("填全之后整条预览都是 healthy", () => {
  const preview = buildRuleFormPreview({
    category: "tunnel",
    entry: "a:1",
    target: "b:2",
    hops: ["Po0", "Jinx"],
  });
  assert.ok(preview.nodes.every((n) => n.health === "healthy"));
  assert.ok(preview.edges.every((e) => e.health === "healthy"));
});

test("没填完时，相邻的线跟着变灰 —— 不能是绿线连着灰点", () => {
  const preview = buildRuleFormPreview({ category: "local", entry: "a:1" });
  assert.equal(preview.edges[0].health, "unknown");
});

test("预览的 title 是一条可读的路径", () => {
  const preview = buildRuleFormPreview({
    category: "tunnel", entry: "a:1", target: "b:2", hops: ["Po0"],
  });
  assert.equal(preview.title, "a:1 → Po0 → b:2");
});
