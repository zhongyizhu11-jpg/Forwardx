import assert from "node:assert/strict";
import test from "node:test";

import {
  buildForwardGroupCreateInput,
  buildTunnelCreateInput,
  describeLinkKind,
  emptyLinkDraft,
  hostSlotLabel,
  linkKindForRouteMode,
  linkKindRequiresAdmin,
  resolveGroupRecordType,
  validateLinkDraft,
} from "./inlineLinkDraft";

test("四种走法各对应一种要建的线路，不认识的走法不给建", () => {
  assert.equal(linkKindForRouteMode("tunnel"), "tunnel");
  assert.equal(linkKindForRouteMode("local"), "portGroup");
  assert.equal(linkKindForRouteMode("chain"), "chainGroup");
  assert.equal(linkKindForRouteMode("group"), "failoverGroup");
  // 以后新增走法时，宁可不显示「＋ 新建」，也不要按错的种类去建
  assert.equal(linkKindForRouteMode("something-new"), null);
});

test("端口转发只在一台机器上开端口", () => {
  const spec = describeLinkKind("portGroup");
  assert.equal(spec.minHosts, 1);
  assert.equal(spec.maxHosts, 1);
});

test("隧道正好两台：入口和出口", () => {
  const spec = describeLinkKind("tunnel");
  assert.equal(spec.minHosts, 2);
  assert.equal(spec.maxHosts, 2);
  assert.equal(hostSlotLabel("tunnel", 0), "入口机");
  assert.equal(hostSlotLabel("tunnel", 1), "出口机");
});

test("机器格子的名字超出预设时退到最后一个，不会变成 undefined", () => {
  assert.equal(hostSlotLabel("chainGroup", 0), "第一跳");
  assert.equal(hostSlotLabel("chainGroup", 1), "第二跳");
  assert.equal(hostSlotLabel("chainGroup", 5), "下一跳");
});

test("新草稿的机器格子数正好等于最少要求", () => {
  assert.equal(emptyLinkDraft("tunnel").hostIds.length, 2);
  assert.equal(emptyLinkDraft("portGroup").hostIds.length, 1);
  assert.equal(emptyLinkDraft("failoverGroup").hostIds.length, 2);
});

test("校验返回的是一句人话，不是 true/false", () => {
  // 「创建」按钮变灰但不说为什么，是最让人恼火的一种交互。
  assert.equal(validateLinkDraft("tunnel", { name: "", hostIds: [1, 2] }), "给这条线路起个名字");
  assert.match(String(validateLinkDraft("tunnel", { name: "x", hostIds: [1, null] })), /还要选满 2 台/);
  assert.match(String(validateLinkDraft("portGroup", { name: "x", hostIds: [null] })), /还要选 转发机/);
  assert.equal(validateLinkDraft("tunnel", { name: "x", hostIds: [1, 2] }), null);
});

test("同一台机器不能在一条线路里出现两次", () => {
  /*
    隧道两端都是同一台 = 自己连自己；转发链里重复 = 流量绕回去。
    都是建完之后才发现跑不通的配置，在提交之前就拦住。
  */
  assert.match(String(validateLinkDraft("tunnel", { name: "x", hostIds: [7, 7] })), /出现两次/);
  assert.match(String(validateLinkDraft("chainGroup", { name: "x", hostIds: [1, 2, 1] })), /出现两次/);
});

test("名字上限跟着服务端 schema 走", () => {
  assert.equal(validateLinkDraft("tunnel", { name: "a".repeat(128), hostIds: [1, 2] }), null);
  assert.match(String(validateLinkDraft("tunnel", { name: "a".repeat(129), hostIds: [1, 2] })), /128/);
});

test("隧道请求体只带必填项，端口留 0 让服务端自己挑", () => {
  /*
    用户此刻想的是「从哪台到哪台」，隧道监听在哪个端口是实现细节。
    要改去线路管理页改。
  */
  const input = buildTunnelCreateInput({ name: "  港日线  ", hostIds: [3, 9] });
  assert.deepEqual(input, { name: "港日线", entryHostId: 3, exitHostId: 9, listenPort: 0 });
});

test("三种转发组落到正确的 groupMode", () => {
  const draft = { name: "g", hostIds: [4, 5] };
  assert.equal(buildForwardGroupCreateInput("portGroup", { name: "g", hostIds: [4] }).groupMode, "port");
  assert.equal(buildForwardGroupCreateInput("chainGroup", draft).groupMode, "chain");
  assert.equal(buildForwardGroupCreateInput("failoverGroup", draft).groupMode, "failover");
});

test("成员顺序就是优先级：转发链按它决定跳序，主备按它决定谁是主", () => {
  const input = buildForwardGroupCreateInput("failoverGroup", { name: "g", hostIds: [11, 22, 33] });
  assert.deepEqual(input.members.map((m) => [m.hostId, m.priority]), [[11, 0], [22, 1], [33, 2]]);
  assert.ok(input.members.every((m) => m.memberType === "host" && m.isEnabled));
});

test("没选满的格子不会变成 null 成员发给服务端", () => {
  const input = buildForwardGroupCreateInput("chainGroup", { name: "g", hostIds: [1, null, 3] });
  assert.deepEqual(input.members.map((m) => m.hostId), [1, 3]);
  // 优先级要按过滤后的实际顺序重排，不能留空档
  assert.deepEqual(input.members.map((m) => m.priority), [0, 1]);
});

test("转发组三兄弟要管理员，隧道不要", () => {
  /*
    租户看到一个点下去必然报 403 的「＋ 新建」，比看不到更糟。
    服务端 forwardGroups.create 是 adminProcedure，tunnels.create 是 protectedProcedure。
  */
  assert.equal(linkKindRequiresAdmin("tunnel"), false);
  assert.equal(linkKindRequiresAdmin("portGroup"), true);
  assert.equal(linkKindRequiresAdmin("chainGroup"), true);
  assert.equal(linkKindRequiresAdmin("failoverGroup"), true);
});

test("格数固定的线路不显示「再加一格」按钮", () => {
  // 隧道正好两端，端口转发就一台机器 —— 给它们一个加号是在暗示可以加，而其实不能
  assert.equal(describeLinkKind("tunnel").addSlotLabel, "");
  assert.equal(describeLinkKind("portGroup").addSlotLabel, "");
  assert.equal(describeLinkKind("chainGroup").addSlotLabel, "再加一跳");
  assert.equal(describeLinkKind("failoverGroup").addSlotLabel, "再加一条备用");
});

test("记录类型按选中的机器推断，不写死 A", () => {
  /*
    写死 A 的后果是一台只有 IPv6 的机器永远建不成主备组，而且要等到点了创建
    才被服务端顶回来：「转发组使用 A 记录时，所有启用成员都需要配置 IPv4」。
  */
  assert.equal(resolveGroupRecordType([{ ipv4: "1.1.1.1" }, { ipv4: "2.2.2.2" }]), "A");
  assert.equal(resolveGroupRecordType([{ ipv6: "2001:db8::1" }, { ipv6: "2001:db8::2" }]), "AAAA");
  // 一台双栈、一台只有 IPv6 —— 共同的是 IPv6
  assert.equal(resolveGroupRecordType([{ ipv4: "1.1.1.1", ipv6: "2001:db8::1" }, { ipv6: "2001:db8::2" }]), "AAAA");
  // 一台只有 IPv4、一台只有 IPv6 —— 没有共同的
  assert.equal(resolveGroupRecordType([{ ipv4: "1.1.1.1" }, { ipv6: "2001:db8::2" }]), null);
  assert.equal(resolveGroupRecordType([]), null);
});

test("空字符串不算有地址", () => {
  assert.equal(resolveGroupRecordType([{ ipv4: "", ipv6: "2001:db8::1" }, { ipv6: "2001:db8::2" }]), "AAAA");
  assert.equal(resolveGroupRecordType([{ ipv4: "   " }, { ipv4: "1.1.1.1" }]), null);
});

test("凑不出同一种记录类型时，创建之前就说清楚", () => {
  const addresses = new Map([
    [1, { ipv4: "1.1.1.1" }],
    [2, { ipv6: "2001:db8::2" }],
  ]);
  const problem = validateLinkDraft("failoverGroup", { name: "g", hostIds: [1, 2] }, addresses);
  assert.match(String(problem), /没有共同的 IP 类型/);
  // 同样两台机器做转发链没有这个限制，不该被拦
  assert.equal(validateLinkDraft("chainGroup", { name: "g", hostIds: [1, 2] }, addresses), null);
});

test("推断出的记录类型进请求体；推不出来就不传，让服务端自己报错", () => {
  const ipv6Only = new Map([[1, { ipv6: "2001:db8::1" }], [2, { ipv6: "2001:db8::2" }]]);
  assert.equal(buildForwardGroupCreateInput("failoverGroup", { name: "g", hostIds: [1, 2] }, ipv6Only).recordType, "AAAA");
  const mixed = new Map([[1, { ipv4: "1.1.1.1" }], [2, { ipv6: "2001:db8::2" }]]);
  assert.equal("recordType" in buildForwardGroupCreateInput("failoverGroup", { name: "g", hostIds: [1, 2] }, mixed), false);
});
