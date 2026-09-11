import assert from "node:assert/strict";
import test from "node:test";

import {
  groupProxyNodes,
  normalizeProxyNodeGroupMode,
  resolveProxyNodeGroupMode,
  PROXY_NODE_AUTO_GROUP_MIN,
  type GroupableProxyNode,
} from "./proxyNodeGrouping";

function node(id: number, protocol: string, state?: "online" | "offline" | "unknown"): GroupableProxyNode {
  return { id, protocol, health: state ? { state } : null };
}

test("不分组时原样返回一整组", () => {
  const nodes = [node(1, "vless"), node(2, "trojan")];
  const groups = groupProxyNodes(nodes, "none");
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].nodes.map((n) => n.id), [1, 2]);
});

test("空列表也给出一组，界面不必单独处理", () => {
  const groups = groupProxyNodes([], "protocol");
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].nodes, []);
});

test("按协议分组，顺序跟着协议表走而不是出现顺序", () => {
  // 否则删掉一个节点就可能让整组换位置，用户会以为自己点错了。
  const groups = groupProxyNodes([
    node(1, "trojan"),
    node(2, "vless"),
    node(3, "trojan"),
  ], "protocol");
  assert.deepEqual(groups.map((g) => g.key), ["protocol:vless", "protocol:trojan"]);
  assert.deepEqual(groups[1].nodes.map((n) => n.id), [1, 3]);
});

test("组内保持传进来的顺序", () => {
  // 传进来的就是用户自己排的 sortOrder，分组不该把它打乱。
  const groups = groupProxyNodes([node(5, "vless"), node(2, "vless"), node(9, "vless")], "protocol");
  assert.deepEqual(groups[0].nodes.map((n) => n.id), [5, 2, 9]);
});

test("空组不出现", () => {
  // 一个「Snell (0)」的空标题只是噪音。
  const groups = groupProxyNodes([node(1, "vless")], "protocol");
  assert.equal(groups.length, 1);
});

test("认不出来的协议兜底成「其他」，不会让节点消失", () => {
  /**
   * 这条守的是「节点从界面上不见了」这种最难查的故障：协议字段脏了或者将来加了
   * 新协议而这里没跟上时，节点必须还在列表里，只是分到了「其他」。
   */
  const groups = groupProxyNodes([node(1, "vless"), node(2, "")], "protocol");
  const total = groups.reduce((sum, group) => sum + group.nodes.length, 0);
  assert.equal(total, 2);
  assert.equal(groups[groups.length - 1].label, "其他");
});

test("按状态分组时离线排在最前面", () => {
  // 按状态分组的用处就是找出问题节点，排在第一屏才有意义。
  const groups = groupProxyNodes([
    node(1, "vless", "online"),
    node(2, "vless", "unknown"),
    node(3, "vless", "offline"),
  ], "health");
  assert.deepEqual(groups.map((g) => g.key), ["health:offline", "health:online", "health:unknown"]);
});

test("没有状态的节点算未知", () => {
  const groups = groupProxyNodes([node(1, "vless")], "health");
  assert.equal(groups[0].key, "health:unknown");
});

test("分组键稳定，不随标签变化", () => {
  // 折叠状态按键记在 localStorage 里，键变了用户的折叠就白设了。
  assert.equal(groupProxyNodes([node(1, "vless")], "protocol")[0].key, "protocol:vless");
  assert.equal(groupProxyNodes([node(1, "vless", "offline")], "health")[0].key, "health:offline");
});

test("分组方式的取值被收敛，脏数据退回自动", () => {
  assert.equal(normalizeProxyNodeGroupMode("protocol"), "protocol");
  assert.equal(normalizeProxyNodeGroupMode("HEALTH"), "health");
  // 兜底值是「自动」而不是「不分组」：没存过偏好的人（以及 localStorage 被清掉的人）
  // 应当直接得到按数量自己调整的那一档，而不是一个节点上到二十个也不分组的列表。
  assert.equal(normalizeProxyNodeGroupMode("乱写的"), "auto");
  assert.equal(normalizeProxyNodeGroupMode(undefined), "auto");
  assert.equal(normalizeProxyNodeGroupMode(null), "auto");
});

test("自动分组：节点少时不分组", () => {
  // 一眼扫得完的列表，分组只是多出几行标题。
  const nodes = [node(1, "vless", "online"), node(2, "trojan", "offline")];
  assert.equal(resolveProxyNodeGroupMode("auto", nodes), "none");
  assert.equal(groupProxyNodes(nodes, "auto").length, 1);
});

test("自动分组：节点多且协议不止一种时按协议分", () => {
  const nodes = Array.from({ length: PROXY_NODE_AUTO_GROUP_MIN }, (_, index) =>
    node(index + 1, index % 2 === 0 ? "vless" : "trojan", "online"));
  assert.equal(resolveProxyNodeGroupMode("auto", nodes), "protocol");
  assert.equal(groupProxyNodes(nodes, "auto").length, 2);
});

test("自动分组：清一色同协议就算再多也不分", () => {
  /**
   * 十个节点全是 Shadowsocks 时分出一个组来，那个标题下面就是原来的整张列表 ——
   * 多一行标题，一点忙没帮上。
   */
  const nodes = Array.from({ length: PROXY_NODE_AUTO_GROUP_MIN + 3 }, (_, index) =>
    node(index + 1, "shadowsocks", "online"));
  assert.equal(resolveProxyNodeGroupMode("auto", nodes), "none");
  assert.equal(groupProxyNodes(nodes, "auto").length, 1);
});

test("手动选过的分组方式不被自动覆盖", () => {
  // 「自动」只是默认值，不是强制 —— 选了按状态就该一直按状态。
  const nodes = [node(1, "vless", "online"), node(2, "vless", "offline")];
  assert.equal(resolveProxyNodeGroupMode("health", nodes), "health");
  assert.equal(resolveProxyNodeGroupMode("none", nodes), "none");
  assert.deepEqual(
    groupProxyNodes(nodes, "health").map((group) => group.key),
    ["health:offline", "health:online"],
  );
});

test("分组不会漏掉或复制任何节点", () => {
  // 最基本的一条：分完组之后总数必须还是那个总数。
  const nodes = [
    node(1, "vless", "online"),
    node(2, "trojan", "offline"),
    node(3, "shadowsocks"),
    node(4, "vless", "offline"),
    node(5, "hysteria2", "online"),
  ];
  for (const mode of ["none", "protocol", "health"] as const) {
    const groups = groupProxyNodes(nodes, mode);
    const ids = groups.flatMap((group) => group.nodes.map((n) => n.id)).sort();
    assert.deepEqual(ids, [1, 2, 3, 4, 5], `分组方式 ${mode} 漏掉或重复了节点`);
  }
});
