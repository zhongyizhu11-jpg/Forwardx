import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  MAX_FAILOVER_SCHEDULE_WINDOWS,
  describeFailoverScheduleWindow,
  failoverScheduleTargetIndexAt,
  parseFailoverSchedule,
  serializeFailoverSchedule,
  failoverSchedulePayload,
  validateFailoverSchedule,
} from "./failoverSchedule";

/**
 * 主备时段表的判定。
 *
 * 这是「晚高峰错峰」要的东西：平时走主线路，18 点到凌晨 1 点改走备用线路，第二天
 * 自动回来。判定同时存在于面板和 Agent —— Agent 必须能在面板挂掉时照常按表走 ——
 * 所以两边共用 failoverSchedule.cases.json 这张用例表，谁改出了偏差谁那边红。
 */

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, "failoverSchedule.cases.json"), "utf8"),
) as { cases: Array<{ name: string; timezone: string; windows: any[]; at: string; expected: number | null }> };

test("共用用例表：面板这一侧的判定", () => {
  // 锚点校验：文件读空了的话下面整轮断言会全部空转。
  assert.ok(fixture.cases.length >= 10, `用例表只读到 ${fixture.cases.length} 条，路径大概不对`);
  for (const testCase of fixture.cases) {
    const schedule = parseFailoverSchedule({ timezone: testCase.timezone, windows: testCase.windows });
    const actual = failoverScheduleTargetIndexAt(schedule, new Date(testCase.at));
    assert.equal(actual, testCase.expected, `${testCase.name}：期望 ${testCase.expected}，拿到 ${actual}`);
  }
});

test("收不下的窗口一条都不留，不要半收", () => {
  const schedule = parseFailoverSchedule({
    timezone: "Asia/Shanghai",
    windows: [
      { days: [], from: "18:00", to: "23:00", targetIndex: 1 },
      { days: [], from: "25:00", to: "26:00", targetIndex: 1 },   // 不是时间
      { days: [], from: "10:00", to: "10:00", targetIndex: 1 },   // 零长度，永远不生效
      { days: [], from: "10:00", to: "11:00", targetIndex: -1 },  // 出站序号不能是负的
    ],
  });
  assert.equal(schedule?.windows.length, 1, "只有第一条是完整的");
});

test("七天全选等于每天，存成同一种写法", () => {
  // 同一个意思有两种写法的话，比较、展示、去重全都要各写一遍。
  const schedule = parseFailoverSchedule({
    timezone: "Asia/Shanghai",
    windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: "18:00", to: "23:00", targetIndex: 1 }],
  });
  assert.deepEqual(schedule?.windows[0].days, []);
});

test("窗口数量有上限", () => {
  const many = Array.from({ length: MAX_FAILOVER_SCHEDULE_WINDOWS + 5 }, () => (
    { days: [], from: "18:00", to: "23:00", targetIndex: 1 }
  ));
  const schedule = parseFailoverSchedule({ timezone: "Asia/Shanghai", windows: many });
  assert.equal(schedule?.windows.length, MAX_FAILOVER_SCHEDULE_WINDOWS);
});

test("没有时区或没有窗口就不是一张表", () => {
  // 半张表最危险：界面上像是配好了，实际什么都不会发生。
  assert.equal(parseFailoverSchedule({ timezone: "", windows: [{ days: [], from: "18:00", to: "23:00", targetIndex: 1 }] }), null);
  assert.equal(parseFailoverSchedule({ timezone: "Asia/Shanghai", windows: [] }), null);
  assert.equal(parseFailoverSchedule(null), null);
  assert.equal(parseFailoverSchedule("不是 JSON"), null);
});

test("存进库再读回来还是同一张表", () => {
  const source = { timezone: "Asia/Shanghai", windows: [{ days: [1, 2, 3, 4, 5], from: "18:00", to: "01:00", targetIndex: 2 }] };
  const stored = serializeFailoverSchedule(source as any);
  assert.ok(stored);
  assert.deepEqual(parseFailoverSchedule(stored), source);
  assert.equal(serializeFailoverSchedule(null), null);
});

test("时段表的文字描述要让人看懂跨没跨午夜", () => {
  assert.equal(
    describeFailoverScheduleWindow({ days: [1, 2, 3, 4, 5], from: "18:00", to: "01:00", targetIndex: 2 }),
    "工作日 18:00-01:00（次日） → 备用 2",
  );
  assert.equal(
    describeFailoverScheduleWindow({ days: [], from: "02:00", to: "06:00", targetIndex: 0 }),
    "每天 02:00-06:00 → 主出站",
  );
  assert.equal(
    describeFailoverScheduleWindow({ days: [0, 6], from: "20:00", to: "23:00", targetIndex: 1 }),
    "周末 20:00-23:00 → 备用 1",
  );
});

test("时段表只在主备模式下生效，别的策略要报错", () => {
  /*
    轮询/随机/IP 哈希本来就不存在「首选是谁」。收下一张不会被读的表，等于告诉
    用户「排好了」而什么都不会发生 —— 这比报错糟得多，因为他不会再去看第二眼。
  */
  const schedule = parseFailoverSchedule({
    timezone: "Asia/Shanghai",
    windows: [{ days: [1, 2, 3, 4, 5], from: "18:00", to: "01:00", targetIndex: 1 }],
  });
  assert.equal(validateFailoverSchedule(schedule, { strategy: "fallback", backupCount: 2 }), null);
  for (const strategy of ["round_robin", "random", "ip_hash"]) {
    assert.match(
      String(validateFailoverSchedule(schedule, { strategy, backupCount: 2 })),
      /只在主备模式下生效/,
      `${strategy} 下应当拦下来`,
    );
  }
});

test("时段表指向不存在的出站要报错", () => {
  // 指向第 5 条而一共只配了 2 条，到点之后静默失效 —— 而那正是它唯一该干活的时刻。
  const make = (targetIndex: number) => parseFailoverSchedule({
    timezone: "Asia/Shanghai",
    windows: [{ days: [], from: "18:00", to: "23:00", targetIndex }],
  });
  assert.match(String(validateFailoverSchedule(make(5), { strategy: "fallback", backupCount: 2 })), /只配了 2 条备用出站/);
  // 边界：正好指向最后一条是合法的，主出站（0）也是。
  assert.equal(validateFailoverSchedule(make(2), { strategy: "fallback", backupCount: 2 }), null);
  assert.equal(validateFailoverSchedule(make(0), { strategy: "fallback", backupCount: 2 }), null);
});

test("没有时段表就没有什么可校验的", () => {
  assert.equal(validateFailoverSchedule(null, { strategy: "round_robin", backupCount: 0 }), null);
});

test("策略不是主备时，发出去的那一份时段表归零", () => {
  /*
    界面上可以先配好时段表、再把策略改成轮询。照样发上去的话服务端会拒绝整次保存，
    用户看到的是「改个策略而已，怎么报了个时段表的错」—— 一个看着能用的控件把保存
    弄失败了，是最难受的那种坏法。
  */
  const schedule = parseFailoverSchedule({
    timezone: "Asia/Shanghai",
    windows: [{ days: [], from: "18:00", to: "23:00", targetIndex: 1 }],
  });
  assert.deepEqual(failoverSchedulePayload(schedule, "fallback"), schedule);
  for (const strategy of ["round_robin", "random", "ip_hash"]) {
    assert.equal(failoverSchedulePayload(schedule, strategy), null, `${strategy} 下不该把时段表发上去`);
  }
  assert.equal(failoverSchedulePayload(null, "fallback"), null);
});

test("归零之后再校验必定通过 —— 两处说的是同一件事", () => {
  // 发送侧和校验侧对不上的话，要么保存莫名失败，要么配置悄悄不生效。
  const schedule = parseFailoverSchedule({
    timezone: "Asia/Shanghai",
    windows: [{ days: [], from: "18:00", to: "23:00", targetIndex: 1 }],
  });
  for (const strategy of ["fallback", "round_robin", "random", "ip_hash"]) {
    const payload = failoverSchedulePayload(schedule, strategy);
    assert.equal(
      validateFailoverSchedule(payload, { strategy, backupCount: 2 }),
      null,
      `${strategy}：按发送侧归零之后，校验侧不该再拦`,
    );
  }
});
