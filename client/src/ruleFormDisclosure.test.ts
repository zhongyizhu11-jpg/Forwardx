import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 「更多设置」折起来的东西，必须是真的可以不看的。
 *
 * 创建转发原来把要填的和可以不管的并排放在同一片方格里：源端口、目标地址、目标端口
 * 旁边就是规则名称、转发工具、异常提醒、出站策略 —— 后四项都有能用的默认值，不动
 * 也能把转发建出来，可它们长得和必填项一模一样。于是每个新手都要当一次选择题：
 * 「转发工具这三个我该选哪个」，而正确答案通常是「别动」。
 *
 * 折叠能解决这个，但折叠也最容易做坏。做坏的三种方式，这一组各钉一条：
 *
 *   · **把必须填的折进去**。用户打不开就交不了表，而他不知道要打开什么。
 *   · **把警告折进去**。警告的全部意义就是被看见，折起来等于删掉。
 *   · **折起来什么都不说**。那叫藏，不叫收纳 —— 折叠条上得挂着里面现在是什么样。
 *
 * 还有第四条在 shared/forwardRuleForm.test.ts：缺口指向折叠里的控件时得自动展开，
 * 否则用户读到一句自己看不见的提示。
 */

const rulesPagePath = path.resolve(import.meta.dirname, "pages/Rules.tsx");

function collapsedSection(source: string): string {
  const start = source.indexOf("{advancedOpen && (");
  assert.notEqual(start, -1, "找不到「更多设置」的折叠块 —— 这条测试锚错了地方");
  const end = source.indexOf("<DialogFooter", start);
  assert.notEqual(end, -1, "折叠块之后找不到对话框的按钮栏");
  const section = source.slice(start, end);
  // 锚点校验：抓空了的话下面的断言会全部空转。
  assert.ok(section.includes("转发工具"), "折叠块里没抓到「转发工具」，范围大概不对");
  assert.ok(section.includes("出站策略"), "折叠块里没抓到「出站策略」，范围大概不对");
  return section;
}

test("折起来的都是可以不管的 —— 里面不许有必填项", () => {
  const section = collapsedSection(fs.readFileSync(rulesPagePath, "utf8"));
  const required = section.split("\n").filter((line) =>
    /text-destructive">\*/.test(line) || /sourcePortRequired/.test(line));
  assert.deepEqual(
    required,
    [],
    "「更多设置」里出现了必填项：\n" + required.join("\n")
      + "\n折叠默认是收起的：用户交不了表，而他不知道要去打开什么。必填的得留在外面。",
  );
});

test("警告不许折进去 —— 折起来就等于删掉", () => {
  const section = collapsedSection(fs.readFileSync(rulesPagePath, "utf8"));
  for (const marker of ["kernelForwardWarning", "border-amber"]) {
    assert.equal(
      section.includes(marker),
      false,
      `「更多设置」里出现了 ${marker}。警告的全部意义就是被看见，`
        + "默认收起的地方放警告，等于这条警告不存在。",
    );
  }
});

test("折叠条上得说清楚里面现在是什么样", () => {
  const source = fs.readFileSync(rulesPagePath, "utf8");
  /*
    从按钮的那行文字切起，不是从「更多设置」四个字切起 —— 这四个字在上面的注释里
    也出现过，按它切会一路切到文件开头，把定义 advancedSummary 的 useMemo 也圈进来，
    于是这条断言永远成立。第一版就是这么写的，反向验证没红才发现。
  */
  const labelAt = source.indexOf("更多设置</span>");
  assert.notEqual(labelAt, -1, "找不到折叠条上的那行字 —— 这条测试锚错了地方");
  const header = source.slice(labelAt, source.indexOf("{advancedOpen && ("));
  assert.ok(header.includes("ChevronDown"), "切出来的不是折叠条 —— 里面连箭头都没有");
  assert.ok(header.length < 1200, `切出来的范围太大了（${header.length} 字），锚点大概滑了`);
  assert.match(
    header,
    /advancedSummary/,
    "折叠条上没有摘要。折起来看不见里面有什么，那叫藏 —— 用户会为了确认一件事"
      + "反复展开收起，比不折还累。",
  );
});

test("缺口指向折叠里的控件时会自动展开", () => {
  const source = fs.readFileSync(rulesPagePath, "utf8");
  assert.match(
    source,
    /const advancedOpen = showAdvanced \|\| advancedBlocked;/,
    "展开条件不再考虑「缺口在不在折叠里」了。footer 说了缺什么、按钮也灰着，"
      + "而那个控件被折叠藏着 —— 用户读到一句自己看不见的话，比什么都不说更糟。",
  );
  assert.match(source, /isAdvancedSectionBlocker\(submitBlocker\)/);
});
