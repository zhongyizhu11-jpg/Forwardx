import assert from "node:assert/strict";
import test from "node:test";

import {
  groupProxyNodes,
  normalizeProxyNodeGroupMode,
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

test("分组方式的取值被收敛，脏数据退回不分组", () => {
  assert.equal(normalizeProxyNodeGroupMode("protocol"), "protocol");
  assert.equal(normalizeProxyNodeGroupMode("HEALTH"), "health");
  assert.equal(normalizeProxyNodeGroupMode("乱写的"), "none");
  assert.equal(normalizeProxyNodeGroupMode(undefined), "none");
  assert.equal(normalizeProxyNodeGroupMode(null), "none");
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
