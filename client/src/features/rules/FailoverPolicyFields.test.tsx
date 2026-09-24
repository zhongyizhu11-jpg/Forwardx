import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { describeRoutePolicy } from "@shared/routePolicy";
import { FailoverPolicyFields, type FailoverPolicyValue } from "./FailoverPolicyFields";

// 2026-09-22（星期二）上海 20:00：在「工作日 18:00–01:00」里。
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const TZ = "Asia/Shanghai";
const schedule = { timezone: TZ, windows: [{ days: [1, 2, 3, 4, 5], from: "18:00", to: "01:00", targetIndex: 1 }] };
const hints = [
  { line: 1, address: "198.51.100.8:443", relay: null, hasProbe: false, probeBlindSpot: false, sameDestination: null },
  { line: 2, address: "198.51.100.9:443", relay: null, hasProbe: false, probeBlindSpot: false, sameDestination: null },
];

/** 「按什么选」那几层在「高级设置」里；这些测试看的是它们，默认展开。看折叠行为的测试传 "auto"（和编辑框一样自己判断）。 */
function render(patch: Partial<FailoverPolicyValue> = {}, advanced: boolean | "auto" = true) {
  const value: FailoverPolicyValue = {
    failoverStrategy: "fallback",
    failoverTargetsText: "198.51.100.8:443\n198.51.100.9:443",
    failoverProbeTarget: "",
    failoverSchedule: null,
    failoverPin: null,
    failoverPreferFastest: false,
    failoverSeconds: 60,
    recoverSeconds: 120,
    failoverMinHoldSeconds: 0,
    autoFailback: true,
    ...patch,
  };
  // 和编辑框一样：拿表单现在的样子走同一份模型。
  const policy = describeRoutePolicy({
    failoverEnabled: true,
    failoverStrategy: value.failoverStrategy,
    targetIp: "198.51.100.7",
    targetPort: 443,
    failoverTargets: JSON.stringify([{ targetIp: "198.51.100.8", targetPort: 443 }, { targetIp: "198.51.100.9", targetPort: 443 }]),
    failoverSchedule: value.failoverSchedule,
    failoverPinnedIndex: value.failoverPin?.index ?? null,
    failoverPinnedUntil: value.failoverPin?.until ?? null,
    failoverPreferFastest: value.failoverPreferFastest,
  }, { nowMs: NOW, timeZone: TZ });
  return renderToStaticMarkup(
    <FailoverPolicyFields
      value={value}
      onChange={() => {}}
      policy={policy}
      lineHints={hints}
      relayCandidates={[]}
      mainAddress="198.51.100.7:443"
      scheduleTimeZone={TZ}
      defaultAdvancedOpen={advanced === "auto" ? undefined : advanced}
      nowMs={NOW}
      timeZone={TZ}
    />,
  );
}

const stateOf = (html: string, testId: string) => html.match(new RegExp(`data-state="(\\w+)" data-testid="${testId}"`))?.[1];

test("按什么选：从上往下是人工指定、时段表、自动择优、其余时候 —— 和 Agent 的优先级一个顺序", () => {
  const html = render({ failoverSchedule: schedule });
  const order = ["policy-pin", "policy-schedule", "policy-fastest", "policy-order"].map((id) => html.indexOf(`data-testid="${id}"`));
  assert.ok(order.every((position) => position > 0), "四层都在");
  assert.deepEqual([...order].sort((left, right) => left - right), order, "顺序就是优先级");
});

test("此刻：拿还没保存的表单算 —— 时段内高亮时段表，而且「此刻」标在命中的那个时段上", () => {
  const html = render({ failoverSchedule: schedule });
  assert.equal(stateOf(html, "policy-schedule"), "deciding");
  assert.equal(stateOf(html, "policy-order"), "idle");
  assert.equal((html.match(/>此刻</g) || []).length, 1, "只有一处「此刻」");
  assert.match(html, /data-state="deciding"><div[^]*?>此刻</, "「此刻」在那个时段的行里，不在层标题上");
});

test("什么都没配时是「按顺序」在决定；配了别的就改叫「其余时候」", () => {
  assert.equal(stateOf(render(), "policy-order"), "deciding");
  assert.match(render(), /按顺序/);
  assert.match(render({ failoverPreferFastest: true }), /其余时候/);
});

test("钉着的时候，人工指定那一层在决定，被压住的时段写明「被人工指定压着」", () => {
  const html = render({ failoverSchedule: schedule, failoverPin: { index: 2, until: Math.floor(NOW / 1000) + 3600 } });
  assert.equal(stateOf(html, "policy-pin"), "deciding");
  assert.match(html, /被人工指定压着/);
  assert.match(html, /到 21:00 自动交回/);
});

test("「一直」这一块选中时，说清楚压住的是时段表和自动择优 —— 不是「自动切换」", () => {
  /*
    上一版写的是「时段表和自动切换都不会再改变走向」。钉住只是「排到最前」，钉住的
    那条挂了照样往下切 —— 自动切换一直在工作，这句话让人以为钉了就没有兜底了。
  */
  const html = render({ failoverPin: { index: 1, until: null } });
  assert.match(html, /aria-pressed="true"[^>]*>一直</);
  assert.match(html, /时段表和自动择优都不会再改变首选/);
  assert.doesNotMatch(html, /自动切换都不会/);
});

test("轮流没有人工指定、时段表、最短驻留、恢复后切回；配过的时段表提示保存后会清空", () => {
  const html = render({ failoverStrategy: "round_robin", failoverSchedule: schedule });
  assert.doesNotMatch(html, /policy-pin|policy-schedule|最短驻留|恢复后切回/);
  assert.match(html, /每条新连接/);
  assert.match(html, /时段表不适用，保存后会清空/);
});

test("勾上主备先看到的是线路和一句话：主线路是上面填的目标，备用一行一条，其余都折在「高级设置」里", () => {
  const html = render({}, "auto");
  assert.match(html, /主线路/);
  assert.match(html, /198\.51\.100\.7:443/, "主线路就是规则自己的目标，得写出来");
  assert.match(html, /value="198\.51\.100\.8:443"/, "备用线路一行一个输入框，不是一个要照语法写的大文本框");
  assert.match(html, /value="198\.51\.100\.9:443"/);
  assert.doesNotMatch(html, /<textarea/);
  assert.match(html, /添加备用线路/);
  assert.match(html, /平时都走主线路/, "一句话说清楚会怎么走");
  assert.match(html, /aria-expanded="false"[^>]*>[^]*?高级设置/);
  assert.match(html, /都是默认值，一般不用动/);
  assert.doesNotMatch(html, /policy-pin|policy-schedule|挂了就切/, "新手用不上的东西默认折起来");
});

test("改过高级项的规则，打开编辑框时「高级设置」直接展开，折叠条上也列着改了什么", () => {
  const html = render({ failoverSchedule: schedule }, "auto");
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /data-testid="policy-schedule"/);
  assert.match(html, /时段表 1 段/);
});

test("还没有备用线路时也给一格输入框，不描述一个不存在的切换", () => {
  const html = render({ failoverTargetsText: "" }, "auto");
  assert.match(html, /placeholder="地址:端口，如 10\.0\.0\.2:443"/);
  assert.match(html, /还没有备用线路/);
});

test("地址写错当场说，不等点保存", () => {
  const html = render({ failoverTargetsText: "10.0.0.2" }, "auto");
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /请按 地址:端口 格式填写/);
});

