import assert from "node:assert/strict";
import test from "node:test";

import { redactSharedProxyNodeRow, shareProxyNodeRow } from "./proxyNodeShare";

test("分享出去的节点一定以直连形态进订阅", () => {
  // 收方名下没有绑着这个节点的转发，直连是唯一出口。不强制打开的话，
  // 管理端显示「已分享」，而对方订阅里一条都不会多出来。
  const row = shareProxyNodeRow({ id: 7, name: "HK", includeDirect: false, frontProxyId: 0 });
  assert.equal(row.includeDirect, true);
});

test("分享出去的节点不带前置代理引用", () => {
  /**
   * frontProxyId 指向节点主人自己的另一行。id 是全表自增的，收方名下恰好有一行
   * 同号节点时，这个引用会落到一个毫不相干的节点上 —— 等于把链路悄悄接到
   * 别人的机器上。必须在这里断掉，不能指望下游「前置没进订阅就不挂引用」兜底。
   */
  const row = shareProxyNodeRow({ id: 7, name: "HK", includeDirect: true, frontProxyId: 3 });
  assert.equal(row.frontProxyId, 0);
});

test("改写不动原来那一行", () => {
  // 同一行节点既要按自己的样子进主人的订阅，又要按分享的样子进收方的订阅。
  // 就地改的话，两边会互相污染。
  const original = { id: 7, name: "HK", includeDirect: false, frontProxyId: 3 };
  shareProxyNodeRow(original);
  assert.equal(original.includeDirect, false);
  assert.equal(original.frontProxyId, 3);
});

test("凭据与其余字段原样带过去", () => {
  // 分享的意思就是让对方连得上，连接需要的字段一个都不能少。
  const row = shareProxyNodeRow({
    id: 7, name: "HK", protocol: "vless", address: "1.2.3.4", port: 443,
    uuid: "u-1", realityPublicKey: "pk", includeDirect: false, frontProxyId: 0,
  });
  assert.equal(row.protocol, "vless");
  assert.equal(row.address, "1.2.3.4");
  assert.equal(row.port, 443);
  assert.equal(row.uuid, "u-1");
  assert.equal(row.realityPublicKey, "pk");
});

test("收方看不到节点主人的套餐与用量", () => {
  // 带宽/总流量/已用是主人的账单口径，对方只需要连得上。
  const row = redactSharedProxyNodeRow({
    id: 7, name: "HK", address: "1.2.3.4", port: 443,
    bandwidthMbps: 500, trafficLimit: 1_000_000_000_000, trafficUsed: 367_000_000_000,
    trafficAutoReset: true, remark: "机房账号 admin@example.com",
  });
  assert.equal(row.bandwidthMbps, 0);
  assert.equal(row.trafficLimit, 0);
  assert.equal(row.trafficUsed, 0);
  assert.equal(row.trafficAutoReset, false);
  // 备注常被当成运维便签，里面可能是机房后台的账号。
  assert.equal(row.remark, null);
  // 但连接需要的字段仍然在。
  assert.equal(row.address, "1.2.3.4");
  assert.equal(row.port, 443);
});

/**
 * 备注和对外标注是两个字段，抹掉一个、留下另一个。
 *
 * 备注是主人自己的账本（「给张三的」「机房账号 xxx」），抹干净是对的。但抹干净
 * 之后收方那一屏就只剩一个没有信息量的「直连」—— 他最想知道的「这条是家宽还是
 * IEPL」恰恰只有主人说得出。所以另开了 publicLabel，它必须跟着节点走。
 */
test("对外标注跟着节点走，备注不出门", () => {
  const row = redactSharedProxyNodeRow({
    id: 7, name: "HKT", address: "1.2.3.4", port: 443,
    remark: "给张三的·便宜线", publicLabel: "家宽",
  } as any);
  assert.equal(row.remark, null, "主人的账本不能出现在收方那边");
  assert.equal(
    (row as any).publicLabel,
    "家宽",
    "抹掉这一句，收方那一屏就只剩一个没有信息量的「直连」",
  );
});

test("没填对外标注就照实没有，不拿备注顶上", () => {
  const row = redactSharedProxyNodeRow({
    id: 8, name: "SG", address: "5.6.7.8", port: 443,
    remark: "这条快到期了",
  } as any);
  assert.equal(row.remark, null);
  assert.ok(
    !(row as any).publicLabel,
    "拿备注当兜底等于把账本换个名字泄出去 —— 宁可什么都不显示",
  );
});
