import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AccountSection, type AccountBilling, type AccountQuota } from "./AccountSection";

const noop = () => {};
const billingOff: AccountBilling = { enabled: false, bytesText: "未开启", amountText: "-", billedText: "已计费 0GB" };
const billingOn: AccountBilling = { enabled: true, bytesText: "4 GB", amountText: "¥4.00", billedText: "已计费 4GB" };
const quota: AccountQuota = {
  hasQuota: true,
  unlimited: false,
  used: 93 * 1024 ** 3,
  limit: 100 * 1024 ** 3,
  percent: 93,
  sourcesText: "额度来源：套餐 100 GB。",
  autoResetDay: 8,
};

function tenant(overrides: Partial<Parameters<typeof AccountSection>[0]> = {}) {
  return renderToStaticMarkup(
    <AccountSection
      isAdmin={false}
      loading={false}
      cacheScope="test"
      onOpen={noop}
      trafficUsed={quota.used}
      billing={billingOn}
      quota={quota}
      expiry={{ dateText: "2026/11/1", label: "剩余 40 天", tone: "normal" }}
      planText="Pro"
      balanceText="¥0.00"
      canForward
      {...overrides}
    />,
  );
}

test("管理员那一块不再有「权限状态：管理员」这类填充项", () => {
  const html = renderToStaticMarkup(
    <AccountSection isAdmin loading={false} cacheScope="test" onOpen={noop} trafficUsed={0} billing={billingOn} />,
  );
  assert.doesNotMatch(html, /权限状态|管理员权限|不受套餐订阅限制/, "管理员自己知道自己是管理员");
  assert.match(html, /已用流量/);
  assert.match(html, /计费流量/);
  assert.doesNotMatch(html, /rounded-lg border/, "不再是卡里套卡");
});

test("按量计费没开时合成一行，不写「计费流量 未开启」「计费消费 -」两行", () => {
  const html = tenant({ billing: billingOff });
  assert.match(html, /按量计费/);
  assert.doesNotMatch(html, /计费消费/);
});

test("转发那一行和「需要关注」用同一个词", () => {
  assert.match(tenant({ canForward: false, forwardPaused: true }), /已暂停/);
  assert.match(tenant({ canForward: false, forwardPaused: false }), /已停用/, "拿不准是不是暂停时，不替它说「暂停」");
  assert.match(tenant({ canForward: true }), /已启用/);
});

test("额度有上限时带一根条，不限时不画", () => {
  assert.match(tenant(), /93%/);
  assert.doesNotMatch(tenant({ quota: { ...quota, limit: 0, unlimited: true } }), /93%/);
});

test("能处理的行点得进去：套餐和余额", () => {
  const opened: string[] = [];
  const html = renderToStaticMarkup(
    <AccountSection
      isAdmin={false}
      loading={false}
      cacheScope="test"
      onOpen={(href) => opened.push(href)}
      trafficUsed={0}
      billing={billingOff}
      quota={quota}
      planText="Pro"
      balanceText="¥0.00"
      canForward
    />,
  );
  assert.equal((html.match(/lucide-chevron-right/g) || []).length, 3, "到期时间、当前套餐、账户余额三行可点；只是看的那几行不画箭头");
});
