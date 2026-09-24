import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { readFailoverPin } from "./failoverPin";

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const HOUR = 3_600_000;

test("没钉就是没钉：null 不能被读成「钉在主线路」", () => {
  /*
    Number(null) 是 0，而 0 是主线路。上一版三处读法都先 Number() 再判断，于是
    没钉过的规则被当成「钉在主线路、一直钉着」下发给 Agent —— 时段表和自动择优
    全部静默失效。
  */
  assert.equal(readFailoverPin({ failoverPinnedIndex: null, failoverPinnedUntil: null }, { nowMs: NOW }), null);
  assert.equal(readFailoverPin({ failoverPinnedIndex: undefined }, { nowMs: NOW }), null);
  assert.equal(readFailoverPin({ failoverPinnedIndex: "" }, { nowMs: NOW }), null);
  assert.equal(readFailoverPin({}, { nowMs: NOW }), null);
  assert.equal(readFailoverPin(null, { nowMs: NOW }), null);
});

test("真的钉在主线路时照认", () => {
  // 修的是「null 被当成 0」，不是「0 不能用」—— 主线路本来就可以被钉住。
  assert.deepEqual(readFailoverPin({ failoverPinnedIndex: 0, failoverPinnedUntil: null }, { nowMs: NOW }), { index: 0, untilMs: null });
});

test("过期的钉子就是没钉，不是「一直钉着」", () => {
  const expired = new Date(NOW - 60_000);
  assert.equal(
    readFailoverPin({ failoverPinnedIndex: 1, failoverPinnedUntil: expired }, { nowMs: NOW }),
    null,
    "早就自动交回的钉子，不能在下一次编辑这条规则时复活成永久的",
  );
});

test("期限的几种写法都认：Date、秒、毫秒；没期限是一直钉着", () => {
  const until = NOW + 2 * HOUR;
  assert.deepEqual(readFailoverPin({ failoverPinnedIndex: 1, failoverPinnedUntil: new Date(until) }, { nowMs: NOW }), { index: 1, untilMs: until });
  assert.deepEqual(readFailoverPin({ failoverPinnedIndex: 1, failoverPinnedUntil: until / 1000 }, { nowMs: NOW }), { index: 1, untilMs: until });
  assert.deepEqual(readFailoverPin({ failoverPinnedIndex: 1, failoverPinnedUntil: until }, { nowMs: NOW }), { index: 1, untilMs: until });
  assert.deepEqual(readFailoverPin({ failoverPinnedIndex: 1, failoverPinnedUntil: 0 }, { nowMs: NOW }), { index: 1, untilMs: null });
});

test("指向不存在的出站当成没钉；期限写坏了也当成没钉", () => {
  assert.equal(readFailoverPin({ failoverPinnedIndex: 3 }, { nowMs: NOW, lineCount: 3 }), null, "一共 3 条，序号 3 越界");
  assert.deepEqual(readFailoverPin({ failoverPinnedIndex: 2 }, { nowMs: NOW, lineCount: 3 }), { index: 2, untilMs: null });
  assert.equal(readFailoverPin({ failoverPinnedIndex: -1 }, { nowMs: NOW }), null);
  assert.equal(readFailoverPin({ failoverPinnedIndex: 1.5 }, { nowMs: NOW }), null);
  assert.equal(
    readFailoverPin({ failoverPinnedIndex: 1, failoverPinnedUntil: "not a date" }, { nowMs: NOW }),
    null,
    "宁可少钉一会儿，也不当成一直钉着 —— 后者会让时段表静默失效",
  );
});

const ROOT = path.resolve(import.meta.dirname, "..");

function collect(dir: string, out: string[] = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.name === "node_modules") continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) collect(full, out);
    else if (/\.tsx?$/.test(item.name) && !/\.test\.tsx?$/.test(item.name)) out.push(full);
  }
  return out;
}

test("钉子只许经 readFailoverPin 读：别处再自己 Number() 一下就红", () => {
  /*
    这个 bug 当初就是三处各自写了一遍 `Number(x.failoverPinnedIndex)`。读法修好了，
    哪天又有一处图省事自己转一下，读法本身的测试照样全绿 —— 所以把「只有一份」也钉住。
  */
  const offenders: string[] = [];
  let scanned = 0;
  for (const dir of ["client/src", "server", "shared"]) {
    for (const file of collect(path.join(ROOT, dir))) {
      const relative = path.relative(ROOT, file);
      if (relative === path.join("shared", "failoverPin.ts")) continue;
      scanned += 1;
      const source = fs.readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      source.split("\n").forEach((line, index) => {
        if (/Number\([^()]*failoverPinnedIndex/.test(line)) offenders.push(`${relative}:${index + 1}`);
      });
    }
  }
  assert.ok(scanned > 200, `只扫到 ${scanned} 个文件，扫描逻辑可能失效了`);
  assert.deepEqual(
    offenders,
    [],
    "这些地方自己把 failoverPinnedIndex 转成了数字。没钉时这一列是 null，Number(null) 是 0，\n"
      + "0 是主线路 —— 改用 shared/failoverPin 的 readFailoverPin：\n  "
      + offenders.join("\n  "),
  );
});
