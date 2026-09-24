import test from "node:test";
import assert from "node:assert/strict";
import { describeFailoverActiveLine, failoverLineEndpoints, failoverLineLabel } from "./failoverActiveLine";

const rule = (patch: Record<string, unknown> = {}) => ({
  failoverEnabled: true,
  targetIp: "10.0.0.1",
  targetPort: 5201,
  failoverTargets: '[{"targetIp":"10.0.0.2","targetPort":5201},{"targetIp":"10.0.0.3","targetPort":5201}]',
  ...patch,
});
const NOW = 1_700_000_000;

test("线路清单：主线路排第 0 位，备用线路按原顺序接在后面", () => {
  assert.deepEqual(failoverLineEndpoints(rule()), ["10.0.0.1:5201", "10.0.0.2:5201", "10.0.0.3:5201"]);
});

test("没开主备的规则不给结论", () => {
  assert.equal(describeFailoverActiveLine(rule({ failoverEnabled: false, failoverActiveTarget: "10.0.0.1:5201" })), null);
});

test("从没上报过就是没有结论，不能替它填「走主线」", () => {
  /*
    这一条是有方向的：把没上报过当成「正常走主线」，会把「Agent 还是旧版、
    压根不报这个字段」显示成一切正常 —— 那正好是最该被看见的情况。
  */
  assert.equal(describeFailoverActiveLine(rule()), null);
  assert.equal(describeFailoverActiveLine(rule({ failoverActiveTarget: "   " })), null);
});

test("走主线路判成主线路，不算在备线上", () => {
  const line = describeFailoverActiveLine(rule({ failoverActiveTarget: "10.0.0.1:5201", failoverActiveAt: NOW }));
  assert.equal(line?.index, 0);
  assert.equal(line?.label, "主线路");
  assert.equal(line?.onBackup, false);
});

test("走第二条备用线路判成备用 2", () => {
  const line = describeFailoverActiveLine(rule({ failoverActiveTarget: "10.0.0.3:5201", failoverActiveAt: NOW }));
  assert.equal(line?.index, 2);
  assert.equal(line?.label, "备用 2");
  assert.equal(line?.onBackup, true);
});

test("地址大小写不同仍然认得出是同一条", () => {
  const line = describeFailoverActiveLine(rule({
    targetIp: "2a0e:97c0::1", targetPort: 443,
    failoverTargets: "[]",
    failoverActiveTarget: "[2A0E:97C0::1]:443",
    failoverActiveAt: NOW,
  }));
  assert.equal(line?.index, 0, "IPv6 换个大小写不该变成「认不出的出站」");
});

test("报上来的地址不在清单里，如实说认不出，而不是硬塞给某一条", () => {
  const line = describeFailoverActiveLine(rule({ failoverActiveTarget: "10.9.9.9:1", failoverActiveAt: NOW }));
  assert.equal(line?.index, -1);
  assert.equal(line?.unknown, true);
  assert.equal(line?.onBackup, false, "认不出的出站不能顺带算成「在备线上」");
  assert.equal(line?.label, "10.9.9.9:1");
});

test("从什么时候起：接口给的是 Date，秒和毫秒也都认", () => {
  /*
    rules.list 经 superjson 给前端的是 Date。上一版对它 Number()，拿到的是毫秒，和秒
    相减永远是负数 —— 靠它判断的「过期」从来没触发过。
  */
  const at = (failoverActiveAt: unknown) => describeFailoverActiveLine(rule({ failoverActiveTarget: "10.0.0.2:5201", failoverActiveAt }))?.since;
  assert.equal(at(new Date(NOW * 1000)), NOW);
  assert.equal(at(NOW), NOW);
  assert.equal(at(NOW * 1000), NOW);
  assert.equal(at(null), null);
});

test("序号称呼", () => {
  assert.equal(failoverLineLabel(0, "x"), "主线路");
  assert.equal(failoverLineLabel(1, "x"), "备用 1");
  assert.equal(failoverLineLabel(-1, "10.0.0.9:1"), "10.0.0.9:1");
});
