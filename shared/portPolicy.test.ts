import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  combineHostPortPolicyWithRange,
  combinePortPolicies,
  isPortAllowedByPolicy,
  pickAvailablePort,
  portPolicyFrom,
  type PortPolicy,
} from "./portPolicy";

test("an identical preferred host range keeps extra allowlist ports", () => {
  const host = {
    portRangeStart: 22600,
    portRangeEnd: 22600,
    portAllowlist: "23001",
  };
  const effective = combineHostPortPolicyWithRange(host, 22600, 22600);

  assert.equal(isPortAllowedByPolicy(22600, effective), true);
  assert.equal(isPortAllowedByPolicy(23001, effective), true);
  assert.equal(isPortAllowedByPolicy(23002, effective), false);
});

test("a narrower preferred range still restricts host extra ports", () => {
  const host = {
    portRangeStart: 22600,
    portRangeEnd: 22699,
    portAllowlist: "23001",
  };
  const effective = combineHostPortPolicyWithRange(host, 22600, 22650);

  assert.equal(isPortAllowedByPolicy(22650, effective), true);
  assert.equal(isPortAllowedByPolicy(22651, effective), false);
  assert.equal(isPortAllowedByPolicy(23001, effective), false);
});

test("disjoint subscription port ranges do not authorize the gap", () => {
  const plan = portPolicyFrom({
    portRanges: [
      { start: 10000, end: 10002 },
      { start: 10010, end: 10012 },
    ],
  });

  assert.equal(isPortAllowedByPolicy(10000, plan), true);
  assert.equal(isPortAllowedByPolicy(10011, plan), true);
  assert.equal(isPortAllowedByPolicy(10006, plan), false);

  const host = portPolicyFrom({ portRangeStart: 10001, portRangeEnd: 10011 });
  const effective = combinePortPolicies(host, plan);
  assert.equal(isPortAllowedByPolicy(10001, effective), true);
  assert.equal(isPortAllowedByPolicy(10006, effective), false);
  assert.equal(isPortAllowedByPolicy(10010, effective), true);

  const selected = pickAvailablePort(effective, new Set([10001, 10010]), { start: 10000, end: 10020 });
  assert.ok(selected === 10002 || selected === 10011 || selected === 10012);
});

test("combining policies preserves sparse ports across the full port domain", () => {
  const sparsePorts = Array.from({ length: 32768 }, (_, index) => index * 2 + 1);
  const sparse = portPolicyFrom({ portAllowlist: sparsePorts.join(",") });
  const fullRange = portPolicyFrom({ portRangeStart: 1, portRangeEnd: 65535 });
  const effective = combinePortPolicies(fullRange, sparse);

  assert.equal(effective.allowlist.length, sparsePorts.length);
  for (let port = 1; port <= 65535; port += 1) {
    assert.equal(isPortAllowedByPolicy(port, effective), port % 2 === 1, `unexpected policy result for ${port}`);
  }
});

test("combining policies keeps disjoint intersections compact", () => {
  const left = portPolicyFrom({
    portRanges: [
      { start: 1000, end: 2000 },
      { start: 10000, end: 20000 },
    ],
  });
  const right = portPolicyFrom({
    portRanges: [
      { start: 1500, end: 2500 },
      { start: 15000, end: 25000 },
    ],
  });

  const effective = combinePortPolicies(left, right);
  assert.deepEqual(effective, {
    rangeStart: 15000,
    rangeEnd: 20000,
    allowlist: [],
    ranges: [{ start: 1500, end: 2000 }],
  });
});

test("manually constructed unsorted policies retain lookup semantics", () => {
  const policy = {
    rangeStart: null,
    rangeEnd: null,
    allowlist: [6000, 1000],
    ranges: [
      { start: 9000, end: 9010 },
      { start: 2000, end: 2010 },
    ],
  };

  assert.equal(isPortAllowedByPolicy(1000, policy), true);
  assert.equal(isPortAllowedByPolicy(2005, policy), true);
  assert.equal(isPortAllowedByPolicy(5000, policy), false);
});

test("deny-all remains absorbing when policies are combined", () => {
  const denyAll = {
    rangeStart: 1000,
    rangeEnd: 2000,
    allowlist: [3000],
    denyAll: true,
  };
  const effective = combinePortPolicies(portPolicyFrom(null), denyAll);

  assert.equal(effective.denyAll, true);
  assert.equal(isPortAllowedByPolicy(1500, effective), false);
  assert.equal(isPortAllowedByPolicy(3000, effective), false);
});

test("interval intersection matches direct policy evaluation", () => {
  const policies: PortPolicy[] = [
    {
      rangeStart: -10,
      rangeEnd: 5000.5,
      allowlist: [65000, 12345],
      ranges: [{ start: 30000, end: 40000 }],
    },
    {
      rangeStart: 2500.25,
      rangeEnd: 35000.75,
      allowlist: [65000],
      ranges: [{ start: 12000, end: 13000 }, { start: 4500, end: 5500 }],
    },
    {
      rangeStart: null,
      rangeEnd: null,
      allowlist: [65000, 12345],
      ranges: [{ start: 1000, end: 32000 }],
    },
  ];
  const directAllows = (port: number, policy: PortPolicy) => !policy.denyAll && (
    (policy.rangeStart !== null && policy.rangeEnd !== null && port >= policy.rangeStart && port <= policy.rangeEnd)
    || (policy.ranges || []).some((range) => port >= range.start && port <= range.end)
    || policy.allowlist.includes(port)
  );
  const effective = combinePortPolicies(...policies);

  for (let port = 1; port <= 65535; port += 1) {
    assert.equal(
      isPortAllowedByPolicy(port, effective),
      policies.every((policy) => directAllows(port, policy)),
      `intersection differs at port ${port}`,
    );
  }
});

test("端口策略只有一处实现", () => {
  /*
    这套逻辑原来在 client/src/pages/Rules.tsx 里另抄了一份，并且漂了：

      - 服务端的策略支持多段 `ranges`（套餐发的端口段就是这么下来的），
        界面那份完全不认 —— 多段策略在界面眼里等于「没有限制」
      - 「不限制」时服务端说「不限制」，界面说「1-65535」，听着像有限制
      - 合并两条策略，界面那份逐个端口试 1..65535（实测 2.042ms），
        服务端是区间求交（0.007ms）

    5 个真实场景跑下来 7 处判定不一致，其中一处是界面把服务端会放行的端口判成
    不可用 —— 那是功能少了一块，不只是提示不准。
  */
  const root = path.resolve(import.meta.dirname, "..");
  const 自己 = path.join("shared", "portPolicy.ts");
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", "dist", ".dev"].includes(item.name)) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(item.name) || /\.test\.tsx?$/.test(item.name)) continue;
      const relative = path.relative(root, full);
      if (relative === 自己) continue;
      const source = fs.readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/function\s+(isPortAllowedByPolicy|describePortPolicy|combinePortPolicies|portPolicyFrom|parsePortAllowlist)\s*[(<]/.test(source)) {
        hits.push(relative);
      }
    }
  };
  for (const dir of ["server", "shared", "client/src"]) walk(path.join(root, dir));
  assert.deepEqual(hits, [], `这些文件又自己写了一份端口策略，请改用 shared/portPolicy.ts：\n  ${hits.join("\n  ")}`);
});
