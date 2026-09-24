import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DiagnoseStatusLine, formatDiagnoseTime } from "./DiagnoseDialog";

/**
 * 诊断一路叫诊断：卡片上的按钮、对话框标题、底部按钮、测的时候那几个字。
 * 原来是「诊断 / 延迟探测 / 链路测试 / 探测中」四个名字。
 */

test("结果那一行：几点测的 + 通 / 超时 / 没通，没通时带原因", () => {
  const at = new Date(2026, 8, 23, 21, 30);
  const ok = renderToStaticMarkup(<DiagnoseStatusLine testing={false} lastRunAt={at} outcome="success" failureReason="不该出现" />);
  assert.match(ok, /上次诊断 <span[^>]*>09-23 21:30<\/span>/);
  assert.match(ok, /fx-healthy-text[^>]*>通</);
  assert.doesNotMatch(ok, /不该出现/, "通了就不写原因");

  const timeout = renderToStaticMarkup(<DiagnoseStatusLine testing={false} lastRunAt={at} outcome="timeout" failureReason="dial tcp 10.0.0.1:443: i/o timeout" />);
  assert.match(timeout, /fx-warn-text[^>]*>超时</);
  assert.match(timeout, /：dial tcp 10\.0\.0\.1:443: i\/o timeout/);

  const failed = renderToStaticMarkup(<DiagnoseStatusLine testing={false} lastRunAt={at} outcome="failed" failureReason={"x".repeat(200)} />);
  assert.match(failed, /fx-down-text[^>]*>没通</);
  assert.match(failed, /x{120}…/, "太长的原因截到 120 字");
});

test("测的时候、从没测过时各说各的", () => {
  assert.match(renderToStaticMarkup(<DiagnoseStatusLine testing lastRunAt={new Date()} outcome="success" />), /正在诊断/);
  assert.match(renderToStaticMarkup(<DiagnoseStatusLine testing={false} lastRunAt={null} />), /还没有诊断过/);
});

test("时间写成「09-23 21:30」；坏值不编一个出来", () => {
  assert.equal(formatDiagnoseTime(new Date(2026, 0, 5, 7, 3)), "01-05 07:03");
  assert.equal(formatDiagnoseTime("not a date"), "");
});

test("规则、隧道、转发链三处诊断都走这个外壳，界面上不再出现「延迟探测」「链路测试」", () => {
  const pages = path.resolve(import.meta.dirname, "../pages");
  for (const file of ["Rules.tsx", "Tunnels.tsx", "ForwardGroups.tsx"]) {
    const source = fs.readFileSync(path.join(pages, file), "utf8");
    assert.match(source, /<DiagnoseDialog\b/, `${file} 用 DiagnoseDialog`);
    assert.doesNotMatch(source, /延迟探测|"链路测试"|"探测中/, `${file} 里没有旧叫法`);
  }
  const view = fs.readFileSync(path.resolve(import.meta.dirname, "LinkTestLatencySummary.tsx"), "utf8");
  assert.doesNotMatch(view, /"等待探测"|"探测中"/);
});
