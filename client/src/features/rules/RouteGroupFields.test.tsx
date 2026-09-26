import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  applyRouteMode,
  newRouteGroupDraft,
  newRoutePath,
  routeGroupRuleFields,
  routeTemplateGuards,
  type RouteGroup,
  type RouteMode,
} from "@shared/routeGroup";
import { describeRoutePolicy } from "@shared/routePolicy";
import { RouteGroupFields, describeRouteGroupPlainly, routeGroupPayload, summarizeRouteAdvanced } from "./RouteGroupFields";

// 2026-09-22（星期二）上海 20:00：在「工作日 18:00–01:00」里。
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const TZ = "Asia/Shanghai";
const hosts = [
  { id: 1, name: "HK entry 01", isOnline: true },
  { id: 2, name: "JP relay 02", isOnline: true },
  { id: 3, name: "SG relay 03", isOnline: false },
];

function group(mode: RouteMode = "failover", patch: Partial<RouteGroup["policy"]> = {}, paths?: RouteGroup["paths"]): RouteGroup {
  const draft = newRouteGroupDraft({ timezone: TZ });
  const list = paths || [
    { ...draft.paths[0], hops: [2] },
    { ...draft.paths[1], name: "备用线路", hops: [3, 2], dest: { ip: "10.95.0.11", port: 443 } },
  ];
  const policy = { ...applyRouteMode(draft.policy, mode, { timezone: TZ, pathCount: list.length }), ...patch };
  return { paths: list, policy };
}

/** 和编辑框一样：拿表单现在的样子走同一份模型算「此刻」。 */
function render(value: RouteGroup, advanced: boolean | "auto" = true) {
  const policy = describeRoutePolicy({
    failoverEnabled: true,
    targetIp: "10.95.0.10",
    targetPort: 443,
    ...routeGroupRuleFields(value, { targetIp: "10.95.0.10", targetPort: 443 }),
  }, { nowMs: NOW, timeZone: TZ });
  return renderToStaticMarkup(
    <RouteGroupFields
      value={value}
      onChange={() => {}}
      hosts={hosts}
      entryHostId={1}
      mainAddress="10.95.0.10:443"
      policy={policy}
      scheduleTimeZone={TZ}
      defaultAdvancedOpen={advanced === "auto" ? undefined : advanced}
      nowMs={NOW}
      timeZone={TZ}
    />,
  );
}

const stateOf = (html: string, testId: string) => html.match(new RegExp(`data-state="(\\w+)" data-testid="${testId}"`))?.[1];

test("每条路径一行：字母、名字、经过哪几台中转、落地；入口机器不在中转候选里", () => {
  const html = render(group());
  assert.equal((html.match(/data-testid="route-path"/g) || []).length, 2);
  assert.match(html, /JP relay 02/);
  assert.match(html, /SG relay 03/);
  assert.match(html, /value="10\.95\.0\.11:443"/, "写了落地的路径把落地填在框里");
  assert.match(html, /placeholder="落地 10\.95\.0\.10:443（同目标）"/, "没写落地的路径说明它走规则自己的目标");
  assert.match(html, /添加路径/);
  assert.match(html, /中转机上的中继由面板自动建/);
});

test("六种策略模板都在，选中的那个带着它会怎么做", () => {
  const html = render(group("smart"));
  for (const template of ["稳定优先", "早晚高峰", "人工掌控", "延迟优先", "晚高峰优化", "负载均衡"]) {
    assert.match(html, new RegExp(template), `模板「${template}」不见了`);
  }
  assert.match(html, /aria-checked="true"[^>]*>[^]*?延迟优先/);
  assert.match(html, /按线路评分（延迟、丢包、抖动、可用率）走最好的一条/);
});

test("定时 / 混合在模板下面直接配时段表，此刻命中的那一段带「此刻」", () => {
  const html = render(group("scheduled"));
  assert.match(html, /data-testid="route-schedule"/);
  assert.equal(stateOf(html, "policy-schedule"), "deciding");
  assert.equal((html.match(/>此刻</g) || []).length, 1, "「此刻」在命中的时段那一行上，只有一处");
  assert.match(html, /工作日 18:00-01:00（次日） → 备用线路/, "时段复述用的是路径的名字");
  assert.doesNotMatch(render(group("failover")), /data-testid="route-schedule"/, "稳定优先没有时段表");
});

test("手动主备在模板下面直接选走哪条，没有「自动」这个选项", () => {
  const html = render(group("manual"));
  assert.match(html, /data-testid="policy-pin"/);
  assert.match(html, /aria-pressed="true"[^>]*>主线路</);
  assert.doesNotMatch(html, /aria-label="强制走哪条路径"[^]*?>自动</);
  assert.doesNotMatch(html, /应急人工指定/, "手动模式下没有第二个人工指定");
});

test("权重负载：分法四选一，按权重时每条路径右边有权重和百分比，没有驻留和切回", () => {
  const html = render(group("weighted"));
  for (const label of ["按权重", "轮流", "随机", "按访客固定"]) assert.match(html, new RegExp(label));
  assert.match(html, /aria-label="路径 A 的权重"/);
  assert.match(html, />50%</);
  assert.doesNotMatch(html, /最短驻留|恢复后切回首选|应急人工指定/);
});

test("一句话说清楚会怎么走，六种模式各一句", () => {
  const plain = (mode: RouteMode, patch: Partial<RouteGroup["policy"]> = {}) => describeRouteGroupPlainly(group(mode, patch));
  assert.match(plain("failover"), /^平时都走 主线路；连续 3 次探测不通、持续 10 秒就换到下一条，切过去至少走 10 分钟，首选恢复并稳定 5 分钟后自动切回。切换只影响新连接/);
  assert.match(plain("scheduled"), /按时段表定首选（1 段），时段外回 主线路/);
  assert.match(plain("manual"), /一直走 主线路，直到你换/);
  assert.match(plain("smart"), /候选高出当前 10 分、连续 3 分钟才换，不来回漂/);
  assert.match(plain("hybrid"), /到点前 5 分钟先预热预检，预检不过就不切；时段外按评分走最好的一条/);
  assert.match(plain("weighted"), /每条新连接按权重分（主线路 50% \/ 备用线路 50%），旧连接不动/);
  assert.match(plain("failover", { switchMode: "force" }), /每次切换都断开旧连接/);
  assert.match(plain("failover", { autoFailback: false }), /首选恢复了也不切回/);
  assert.match(describeRouteGroupPlainly({ ...group(), paths: [newRoutePath(0)] }), /还没有第二条路径/);
});

test("高级策略默认折起来，折叠条上只列改过模板值的项；改过的打开时直接展开", () => {
  const html = render(group(), "auto");
  assert.match(html, /aria-expanded="false"[^>]*>[^]*?高级策略/);
  assert.match(html, /按模板预填，一般不用动/);
  assert.doesNotMatch(html, /切换保护|连续失败/, "新手用不上的东西默认折起来");

  const changed = render(group("hybrid", { failureThreshold: 5, switchMode: "force", prewarmSeconds: 0 }), "auto");
  assert.match(changed, /aria-expanded="true"/);
  assert.match(changed, /连续失败 5 次 · 不预热 · 强制切换/);
});

test("高级策略里按模式给控件：择优门槛只在智能 / 混合，预热只在定时 / 混合，应急指定只在自动模式", () => {
  const smart = render(group("smart"));
  assert.match(smart, /择优门槛/);
  assert.doesNotMatch(smart, /计划切换预热/);
  assert.match(smart, /应急人工指定/);
  const scheduled = render(group("scheduled"));
  assert.match(scheduled, /计划切换预热/);
  assert.doesNotMatch(scheduled, /择优门槛/);
  const hybrid = render(group("hybrid"));
  assert.match(hybrid, /择优门槛/);
  assert.match(hybrid, /计划切换预热/);
  assert.match(hybrid, /预检不过就不切，继续走当前这条/);
  for (const mode of ["failover", "scheduled", "manual", "smart", "hybrid", "weighted"] as RouteMode[]) {
    assert.match(render(group(mode)), /切换时旧连接怎么办[^]*?平滑切换[^]*?快速故障转移[^]*?强制切换/, `${mode} 少了旧连接三选一`);
  }
});

test("应急指定钉着时，时段表那一行写明被压着，「一直」说清楚压住的是时段表和评分", () => {
  const html = render(group("scheduled", { pin: { index: 0, untilMs: null } }));
  assert.equal(stateOf(html, "policy-pin"), "deciding");
  assert.match(html, /被人工指定压着/);
  assert.match(html, /aria-pressed="true"[^>]*>一直</);
  assert.match(html, /时段表和评分都不会再改变首选/);
});

test("每条路径可以填自己的探测地址；写错当场说", () => {
  const html = render(group("failover", {}, [
    { ...newRoutePath(0), probe: { ip: "10.95.0.10", port: 8443 } },
    newRoutePath(1),
  ]));
  assert.match(html, /value="10\.95\.0\.10:8443"/);
  assert.match(html, /placeholder="留空就探拨号地址"/);
  assert.match(html, /每台中转探它的下一跳/);
});

test("提交的那份按模式归零：时段表只在定时 / 混合，指定不在权重负载，解析出来的 dial / issue 不发", () => {
  const scheduled = routeGroupPayload(group("scheduled", { pin: { index: 1, untilMs: null } }));
  assert.equal(scheduled.schedule?.windows.length, 1);
  assert.deepEqual(scheduled.pin, { index: 1, untilMs: null });
  assert.ok(!("dial" in scheduled.paths[0]) && !("issue" in scheduled.paths[0]));
  const weighted = routeGroupPayload(group("weighted", { schedule: group("scheduled").policy.schedule, pin: { index: 1, untilMs: null } }));
  assert.equal(weighted.schedule, null);
  assert.equal(weighted.pin, null);
  assert.equal(routeGroupPayload(group("failover", { schedule: group("scheduled").policy.schedule })).schedule, null);
});

test("摘要只列和模板不一样的", () => {
  const policy = applyRouteMode(newRouteGroupDraft({ timezone: TZ }).policy, "failover", { timezone: TZ, pathCount: 2 });
  assert.deepEqual(summarizeRouteAdvanced({ policy, probes: 0 }), []);
  assert.deepEqual(routeTemplateGuards("failover").minHoldSeconds, 600);
  assert.deepEqual(summarizeRouteAdvanced({ policy: { ...policy, minHoldSeconds: 0, autoFailback: false }, probes: 2 }), ["不限驻留", "恢复后不切回", "探测地址 2 条"]);
});
