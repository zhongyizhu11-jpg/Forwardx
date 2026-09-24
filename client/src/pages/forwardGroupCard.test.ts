import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 转发组卡片（端口转发、转发链、转发组、入口组、出口组五个 tab 共用一个渲染函数）。
 *
 * 卡片底部原来是两个带边框的小框，一个值一个框；而且一半是在重复上面写过的话（「所属主机」
 * 就是成员那一块的标题，「引用规则 N」状态那句已经说了，「用途 · 固定出口」就是所在的 tab）。
 * 现在只留上面没说过的，写成和套餐卡、监控卡同一种细线下两列的小表。
 *
 * 这条守在源码上：以后有人在这张卡里再套一个 rounded-md border 的小框，这里会报出来。
 */
const source = fs.readFileSync(path.resolve(import.meta.dirname, "ForwardGroups.tsx"), "utf8");

function slice(from: string, to: string) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start > 0 && end > start, `找得到 ${from} … ${to}`);
  return source.slice(start, end);
}

test("转发组卡片里不再套带边框的小框", () => {
  const card = slice("const renderForwardGroupCard", "const renderTableMembersSummary");
  assert.doesNotMatch(card, /rounded-md border/);
  // 反向对照：取到的确实是那张卡（CardActions 在里面），底部换成了小表
  assert.match(card, /<CardActions>/);
  assert.match(card, /renderGroupFacts\(group\)/);
});

test("小表只写上面没说过的：DDNS 域名、链路延迟、没有入口组时的入口地址", () => {
  const facts = slice("const renderGroupFacts", "const renderForwardGroupCard");
  assert.match(facts, /<dl className="[^"]*border-t border-\[var\(--fx-stroke-weak\)\]/);
  assert.doesNotMatch(facts, /引用规则|用途|固定入口|固定出口|所属主机/, "这几项上面已经写过");
  // 有入口组的转发链，路径第一个节点就是入口组，不再写一遍
  assert.match(facts, /if \(!entryGroupDisplayText\(group, groupsByMode\) && entryAddress\)/);
});
