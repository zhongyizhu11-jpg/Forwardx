import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 列表卡片的操作只在右上角那一个 ···（EntityActions menuOnly），不再在卡底部再画一行
 * 「诊断 / 编辑 / ···」。两处是同一组操作画了两遍，每张卡为此多 60px。
 * 表格行不受影响：那里没有右上角，常驻的两个带字按钮留着。
 *
 * 守在源码上：以后有人把 CardActions 写回规则 / 隧道 / 转发组 / 套餐卡里，这里会报出来。
 */
const read = (relative: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../..", relative), "utf8");

test("规则、隧道、转发组、套餐的卡片不再有底部操作行", () => {
  for (const file of ["pages/Rules.tsx", "pages/Tunnels.tsx", "pages/ForwardGroups.tsx", "pages/Plans.tsx"]) {
    const source = read(file);
    assert.doesNotMatch(source, /<CardActions/, `${file} 不再画底部操作行`);
    assert.match(source, /menuOnly/, `${file} 的卡片操作收进右上角的 ···`);
  }
});

test("menuOnly 时所有操作都在菜单里，一级操作排在最前，删除仍然最后", async () => {
  const { partitionEntityActions } = await import("./EntityActions");
  const parts = partitionEntityActions(
    [{ key: "edit", label: "编辑", onSelect() {} }, { key: "test", label: "诊断", onSelect() {} }],
    [{ key: "delete", label: "删除", destructive: true, onSelect() {} }, { key: "latency", label: "延迟", onSelect() {} }],
    { menuOnly: true },
  );
  assert.deepEqual(parts.shown, []);
  assert.deepEqual(parts.safe.map((a) => a.key), ["edit", "test", "latency"]);
  assert.deepEqual(parts.destructive.map((a) => a.key), ["delete"]);
});
