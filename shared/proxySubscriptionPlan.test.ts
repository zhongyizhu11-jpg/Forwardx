import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProxySubscriptionPlan,
  dedupeProxyNodeNames,
  defaultProxySubscriptionNodeName,
  proxyNodeFromTemplateRow,
  type ProxyNodeTemplateRow,
  type ProxySubscriptionHostRow,
  type ProxySubscriptionRuleRow,
} from "./proxySubscriptionPlan";

const HKT_TEMPLATE: ProxyNodeTemplateRow = {
  id: 1,
  name: "HKT",
  protocol: "vless",
  address: "hkt.example.com",
  port: 443,
  uuid: "abc-uuid",
  transport: "ws",
  path: "/ray",
  tls: true,
  sni: "hkt.example.com",
  isEnabled: true,
};

const HOSTS: ProxySubscriptionHostRow[] = [
  { id: 1, name: "广州1", ip: "1.2.3.4", ipv4: "1.2.3.4" },
  { id: 2, name: "广州2", ip: "5.6.7.8", ipv4: "5.6.7.8" },
];

function rule(overrides: Partial<ProxySubscriptionRuleRow> & { id: number }): ProxySubscriptionRuleRow {
  return {
    hostId: 1,
    name: "转发",
    sourcePort: 20001,
    proxyNodeId: 1,
    proxyNodeVisible: true,
    isEnabled: true,
    pendingDelete: false,
    ...overrides,
  };
}

test("两台前置指向同一落地节点会生成两个节点", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [
      rule({ id: 1, hostId: 1, sourcePort: 20001 }),
      rule({ id: 2, hostId: 2, sourcePort: 20002 }),
    ],
    templates: [HKT_TEMPLATE],
    hosts: HOSTS,
  });

  assert.equal(plan.entries.length, 2);
  assert.equal(plan.skipped.length, 0);

  const [first, second] = plan.entries;
  assert.equal(first.node.name, "广州1 → HKT");
  assert.equal(first.node.address, "1.2.3.4");
  assert.equal(first.node.port, 20001);
  assert.equal(second.node.name, "广州2 → HKT");
  assert.equal(second.node.address, "5.6.7.8");
  assert.equal(second.node.port, 20002);

  // 凭据与握手参数来自模板，两个节点完全一致。
  for (const entry of plan.entries) {
    assert.equal(entry.node.uuid, "abc-uuid");
    assert.equal(entry.node.sni, "hkt.example.com");
    assert.equal(entry.node.path, "/ray");
  }
});

test("单个节点可以在订阅里隐藏，且能说明原因", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [
      rule({ id: 1, hostId: 1 }),
      rule({ id: 2, hostId: 2, sourcePort: 20002, proxyNodeVisible: false, name: "备用转发" }),
    ],
    templates: [HKT_TEMPLATE],
    hosts: HOSTS,
  });

  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0].ruleId, 1);
  assert.deepEqual(plan.skipped, [{ ruleId: 2, ruleName: "备用转发", reason: "hidden" }]);
});

test("未绑定模板的转发不进订阅", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [rule({ id: 1, proxyNodeId: null, name: "普通转发" })],
    templates: [HKT_TEMPLATE],
    hosts: HOSTS,
  });

  assert.equal(plan.entries.length, 0);
  assert.equal(plan.skipped[0].reason, "unbound");
});

test("停用的转发和停用的模板都会被排除", () => {
  const disabledRule = buildProxySubscriptionPlan({
    rules: [rule({ id: 1, isEnabled: false })],
    templates: [HKT_TEMPLATE],
    hosts: HOSTS,
  });
  assert.equal(disabledRule.entries.length, 0);
  assert.equal(disabledRule.skipped[0].reason, "rule-disabled");

  const disabledTemplate = buildProxySubscriptionPlan({
    rules: [rule({ id: 1 })],
    templates: [{ ...HKT_TEMPLATE, isEnabled: false }],
    hosts: HOSTS,
  });
  assert.equal(disabledTemplate.entries.length, 0);
  assert.equal(disabledTemplate.skipped[0].reason, "template-disabled");
});

test("待删除的转发既不出节点也不报原因", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [rule({ id: 1, pendingDelete: true })],
    templates: [HKT_TEMPLATE],
    hosts: HOSTS,
  });

  assert.equal(plan.entries.length, 0);
  // 已经在删除流程里的规则不是用户需要处理的问题，不该出现在提示列表。
  assert.equal(plan.skipped.length, 0);
});

test("入口主机没有可用地址时报明确原因而不是生成坏节点", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [rule({ id: 1, hostId: 9 })],
    templates: [HKT_TEMPLATE],
    hosts: [{ id: 9, name: "空主机" }],
  });

  assert.equal(plan.entries.length, 0);
  assert.equal(plan.skipped[0].reason, "no-entry-address");
});

test("主机配了入口域名时订阅用域名而不是 IP", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [rule({ id: 1, hostId: 3 })],
    templates: [HKT_TEMPLATE],
    hosts: [{ id: 3, name: "广州1", ip: "1.2.3.4", ipv4: "1.2.3.4", entryIp: "gz1.example.com" }],
  });

  assert.equal(plan.entries[0].node.address, "gz1.example.com");
});

test("自定义节点名覆盖自动生成的名称", () => {
  const plan = buildProxySubscriptionPlan({
    rules: [rule({ id: 1, proxyNodeName: "主力线路" })],
    templates: [HKT_TEMPLATE],
    hosts: HOSTS,
  });

  assert.equal(plan.entries[0].node.name, "主力线路");
});

test("同名节点自动加序号", () => {
  // Clash 的 proxy-groups 按名称引用节点，重名会让客户端随机少几个节点。
  const nodes = dedupeProxyNodeNames([
    { ...proxyNodeFromTemplateRow(HKT_TEMPLATE), name: "香港" },
    { ...proxyNodeFromTemplateRow(HKT_TEMPLATE), name: "香港" },
    { ...proxyNodeFromTemplateRow(HKT_TEMPLATE), name: "香港" },
    { ...proxyNodeFromTemplateRow(HKT_TEMPLATE), name: "日本" },
  ]);

  assert.deepEqual(nodes.map((node) => node.name), ["香港", "香港 #2", "香港 #3", "日本"]);
});

test("模板行的宽松字段被收敛成合法模型", () => {
  const node = proxyNodeFromTemplateRow({
    id: 1,
    name: "SS",
    protocol: "SHADOWSOCKS",
    address: "hk.example.com",
    port: "8388",
    method: "aes-128-gcm",
    password: "pass",
    transport: "不认识的值",
    tls: 0,
    alpn: "h2, http/1.1",
    udp: 1,
  });

  assert.equal(node.protocol, "shadowsocks");
  assert.equal(node.port, 8388);
  assert.equal(node.transport, "tcp");
  assert.equal(node.tls, false);
  assert.deepEqual(node.alpn, ["h2", "http/1.1"]);
  assert.equal(node.udp, true);
});

test("节点名在主机名或模板名缺失时仍有可用回退", () => {
  assert.equal(
    defaultProxySubscriptionNodeName({ hostName: "广州1", templateName: "HKT", ruleName: "转发" }),
    "广州1 → HKT",
  );
  assert.equal(defaultProxySubscriptionNodeName({ hostName: "", templateName: "HKT", ruleName: "转发" }), "HKT");
  assert.equal(defaultProxySubscriptionNodeName({ hostName: "广州1", templateName: "", ruleName: "转发" }), "广州1");
  assert.equal(defaultProxySubscriptionNodeName({ hostName: "", templateName: "", ruleName: "转发" }), "转发");
  assert.equal(defaultProxySubscriptionNodeName({ hostName: "", templateName: "", ruleName: "" }), "节点");
});

// ==================== 中转自动选路分组 ====================

import {
  autoGroupNameForTemplate,
  buildProxySubscriptionDocument,
  normalizeProxyNodeAutoGroup,
} from "./proxySubscriptionPlan";

function planFor(rules: ProxySubscriptionRuleRow[], templates: ProxyNodeTemplateRow[]) {
  return buildProxySubscriptionPlan({ rules, templates, hosts: HOSTS });
}

test("同一落地节点被两台中转指向时生成自动选路组", () => {
  const templates = [HKT_TEMPLATE];
  const plan = planFor(
    [rule({ id: 1, hostId: 1, sourcePort: 20001 }), rule({ id: 2, hostId: 2, sourcePort: 20002 })],
    templates,
  );

  const doc = buildProxySubscriptionDocument(plan, templates, { mainGroupName: "ForwardX" });

  assert.equal(doc.groups.length, 2);
  const [main, auto] = doc.groups;

  assert.equal(main.name, "ForwardX");
  assert.equal(main.type, "select");
  // 自动选路组排在裸节点前面，用户第一眼就是「自动」。
  assert.deepEqual(main.members, ["HKT 自动选路", "广州1 → HKT", "广州2 → HKT"]);

  assert.equal(auto.name, "HKT 自动选路");
  assert.equal(auto.type, "url-test");
  assert.deepEqual(auto.members, ["广州1 → HKT", "广州2 → HKT"]);
});

test("只有一台中转时不生成自动选路组", () => {
  const templates = [HKT_TEMPLATE];
  const plan = planFor([rule({ id: 1, hostId: 1 })], templates);

  const doc = buildProxySubscriptionDocument(plan, templates, { mainGroupName: "ForwardX" });

  // 一条线路无从选路，多一个组只会让客户端界面变乱。
  assert.equal(doc.groups.length, 1);
  assert.equal(doc.groups[0].type, "select");
  assert.deepEqual(doc.groups[0].members, ["广州1 → HKT"]);
});

test("模板可以关闭自动选路，或改成主备切换", () => {
  const off = [{ ...HKT_TEMPLATE, autoGroup: "off" }];
  const offDoc = buildProxySubscriptionDocument(
    planFor([rule({ id: 1, hostId: 1 }), rule({ id: 2, hostId: 2, sourcePort: 20002 })], off),
    off,
    { mainGroupName: "ForwardX" },
  );
  assert.equal(offDoc.groups.length, 1);
  assert.deepEqual(offDoc.groups[0].members, ["广州1 → HKT", "广州2 → HKT"]);

  const fallback = [{ ...HKT_TEMPLATE, autoGroup: "fallback" }];
  const fallbackDoc = buildProxySubscriptionDocument(
    planFor([rule({ id: 1, hostId: 1 }), rule({ id: 2, hostId: 2, sourcePort: 20002 })], fallback),
    fallback,
    { mainGroupName: "ForwardX" },
  );
  assert.equal(fallbackDoc.groups[1].type, "fallback");
});

test("多个落地节点各自成组，互不混淆", () => {
  const second: ProxyNodeTemplateRow = { ...HKT_TEMPLATE, id: 2, name: "日本" };
  const templates = [HKT_TEMPLATE, second];
  const plan = planFor(
    [
      rule({ id: 1, hostId: 1, sourcePort: 20001, proxyNodeId: 1 }),
      rule({ id: 2, hostId: 2, sourcePort: 20002, proxyNodeId: 1 }),
      rule({ id: 3, hostId: 1, sourcePort: 20003, proxyNodeId: 2 }),
      rule({ id: 4, hostId: 2, sourcePort: 20004, proxyNodeId: 2 }),
    ],
    templates,
  );

  const doc = buildProxySubscriptionDocument(plan, templates, { mainGroupName: "ForwardX" });
  const autoGroups = doc.groups.filter((group) => group.type !== "select");

  assert.equal(autoGroups.length, 2);
  assert.deepEqual(autoGroups[0].members, ["广州1 → HKT", "广州2 → HKT"]);
  assert.deepEqual(autoGroups[1].members, ["广州1 → 日本", "广州2 → 日本"]);
});

test("分组引用的是去重后的节点名", () => {
  // 组按名称引用成员，若用去重前的名字，客户端会找不到节点。
  const templates = [HKT_TEMPLATE];
  const plan = planFor(
    [
      rule({ id: 1, hostId: 1, sourcePort: 20001, proxyNodeName: "香港" }),
      rule({ id: 2, hostId: 2, sourcePort: 20002, proxyNodeName: "香港" }),
    ],
    templates,
  );

  const doc = buildProxySubscriptionDocument(plan, templates, { mainGroupName: "ForwardX" });

  assert.deepEqual(doc.nodes.map((node) => node.name), ["香港", "香港 #2"]);
  assert.deepEqual(doc.groups[1].members, ["香港", "香港 #2"]);
});

test("没有节点时不产出任何策略组", () => {
  const doc = buildProxySubscriptionDocument({ entries: [], skipped: [] }, [HKT_TEMPLATE], {
    mainGroupName: "ForwardX",
  });

  assert.deepEqual(doc.nodes, []);
  assert.deepEqual(doc.groups, []);
});

test("自动选路模式的取值收敛", () => {
  assert.equal(normalizeProxyNodeAutoGroup("off"), "off");
  assert.equal(normalizeProxyNodeAutoGroup("fallback"), "fallback");
  assert.equal(normalizeProxyNodeAutoGroup("URL-TEST"), "url-test");
  // 未设置时默认开启自动选路，这是多中转场景下最有用的行为。
  assert.equal(normalizeProxyNodeAutoGroup(undefined), "url-test");
  assert.equal(normalizeProxyNodeAutoGroup("乱填"), "url-test");
});

test("组名带后缀，避免和落地节点本身重名", () => {
  assert.equal(autoGroupNameForTemplate("HKT"), "HKT 自动选路");
  assert.equal(autoGroupNameForTemplate(""), "节点 自动选路");
});
