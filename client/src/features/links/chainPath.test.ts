import assert from "node:assert/strict";
import test from "node:test";

import { buildChainPath, chainMemberHealth } from "./chainPath";

const members = [
  { id: 1, label: "Po0", active: true },
  { id: 2, label: "Relay-HK", active: true },
  { id: 3, label: "Jinx", active: true },
];

test("节点顺序就是链的顺序，不再带序号和角色名", () => {
  /*
    「1. 入口 · Po0」里有三份冗余：序号说它排第一，角色名再说一遍，位置第三次
    说了同样的话。挤掉的是真正该显示的东西 —— 这一跳连的是哪个地址。
  */
  const path = buildChainPath(members);
  assert.deepEqual(path.nodes.map((n) => n.name), ["Po0", "Relay-HK", "Jinx"]);
  const text = JSON.stringify(path.nodes);
  assert.doesNotMatch(text, /入口|中转|出口/);
  assert.doesNotMatch(text, /"1\.|"2\.|"3\./);
});

test("有外部入口组时，它排在所有成员之前", () => {
  const path = buildChainPath(members, { externalEntryLabel: "聚合入口" });
  assert.equal(path.nodes[0].name, "聚合入口");
  assert.equal(path.nodes[0].sublabel, "入口组");
  assert.equal(path.nodes.length, members.length + 1);
});

test("没在生效的一跳是 unknown，不是 down", () => {
  /*
    active 为 false 可能是「这一跳坏了」，也可能是「还没探测到这一跳」。
    把后者画成红色，等于报一个还不存在的故障。
  */
  assert.equal(chainMemberHealth({ id: 1, label: "x" }), "unknown");
  assert.equal(chainMemberHealth({ id: 1, label: "x", active: false }), "unknown");
  assert.notEqual(chainMemberHealth({ id: 1, label: "x", active: false }), "down");
});

test("明确停用的一跳是 standby，优先于 active", () => {
  // 停用是按设计没在跑，和「探不到」是两回事。
  assert.equal(chainMemberHealth({ id: 1, label: "x", enabled: false, active: true }), "standby");
});

test("在生效的一跳是 healthy", () => {
  assert.equal(chainMemberHealth({ id: 1, label: "x", active: true }), "healthy");
});

test("延迟只标在中间那一段", () => {
  const path = buildChainPath(members, { latencyMs: 42 });
  const labelled = path.edges.filter((e) => e.latencyMs != null);
  assert.equal(labelled.length, 1);
  assert.equal(labelled[0].latencyMs, 42);
});

test("探测超时整条画成 down，而不是 degraded", () => {
  // 超时不是「慢」，是「没通」。画成琥珀会让人以为还能用，只是差一点。
  const path = buildChainPath(members, { isTimeout: true, latencyMs: null });
  assert.ok(path.edges.every((e) => e.health === "down"));
  assert.match(path.title, /探测超时/);
});

test("一段线的状态取两端节点里更该被注意的那个", () => {
  /*
    第一版整条链统一 healthy，实机上出现了绿线连着两个灰点：线说「这一段没
    问题」，点说「不知道」—— 同一个位置两个互相矛盾的结论。线不携带独立的
    探测数据，它能说的只有「它连的那两个点怎么样」。
  */
  const path = buildChainPath([
    { id: 1, label: "Po0", active: true },
    { id: 2, label: "Relay", active: false },
    { id: 3, label: "Jinx", active: true },
  ]);
  // healthy ↔ unknown 这一段不能是绿的
  assert.equal(path.edges[0].health, "unknown");
  assert.equal(path.edges[1].health, "unknown");
});

test("两端都在生效时线才是绿的", () => {
  const path = buildChainPath([
    { id: 1, label: "Po0", active: true },
    { id: 2, label: "Jinx", active: true },
  ]);
  assert.equal(path.edges[0].health, "healthy");
});

test("停用的一跳让相邻的线变成待命，不是故障", () => {
  const path = buildChainPath([
    { id: 1, label: "Po0", active: true },
    { id: 2, label: "Relay", enabled: false },
  ]);
  assert.equal(path.edges[0].health, "standby");
});

test("没超时也没延迟时，边不带任何标注", () => {
  const path = buildChainPath(members);
  assert.ok(path.edges.every((e) => e.latencyMs == null && !e.via));
});

test("边比节点少一条", () => {
  const path = buildChainPath(members, { externalEntryLabel: "聚合入口" });
  assert.equal(path.edges.length, path.nodes.length - 1);
});

test("空成员列表不抛错", () => {
  const path = buildChainPath([]);
  assert.equal(path.nodes.length, 0);
  assert.equal(path.edges.length, 0);
  assert.equal(path.title, "");
});

test("只有外部入口、没有成员时也能画出一个节点", () => {
  const path = buildChainPath([], { externalEntryLabel: "聚合入口" });
  assert.equal(path.nodes.length, 1);
  assert.equal(path.edges.length, 0);
});

test("title 带完整链路，窄屏截断时还读得到", () => {
  const path = buildChainPath(members, { latencyMs: 42 });
  assert.match(path.title, /Po0 → Relay-HK → Jinx/);
  assert.match(path.title, /42 ms/);
});

test("成员的补充信息进注脚，不和名字挤在一行", () => {
  const path = buildChainPath([{ id: 1, label: "Po0", sublabel: "内网 10.0.0.1", active: true }]);
  assert.equal(path.nodes[0].name, "Po0");
  assert.equal(path.nodes[0].sublabel, "内网 10.0.0.1");
});
