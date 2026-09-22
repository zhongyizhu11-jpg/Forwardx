import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 界面里不许再出现调色板名字（emerald-500、amber-600、rose-500…）。
 *
 * ── 为什么这是个问题 ──
 *
 * 不是「有颜色」有问题 —— 状态色本来就该有颜色。问题是这些类**绕过了令牌**：
 *
 * 1. 深色模式每一处都要手写一遍 `dark:` 变体，漏一个就在深色下糊掉。
 *    清理之前全站有 100 多个 `dark:text-amber-300` 这样的补丁，全是在手工
 *    重做令牌已经做好的事。
 * 2. 改配色要 grep 三十个文件，必然漏。
 * 3. 同一个「正常绿」在不同文件里慢慢漂成两种绿 —— 主机页用 `--fx-healthy`
 *    #1a8c4a，饼图里的「在线」却是 emerald-500 #10b981，用户看到的是两个绿。
 *
 * ── 该用什么 ──
 *
 * `var(--fx-healthy)` / `--fx-warn` / `--fx-down` / `--fx-standby` /
 * `--fx-path` / `--fx-delivery`，文字用 `-text` 那一档，浅底用 `-soft`。
 * 深浅色两套值都在令牌里，用了就不用再写 `dark:`。
 *
 * 纯装饰（按卡片刷不同颜色、按类型刷不同颜色）不该有颜色，走中性。
 */

const PALETTE = "emerald|amber|rose|sky|violet|lime|teal|cyan|indigo|fuchsia|orange|green|red|blue|yellow|purple|pink";
const PATTERN = new RegExp(`\\b(?:${PALETTE})-(?:50|[1-9]00)(?:/\\d+)?\\b`);

/*
 * 注释里写得出这些名字 —— 好几段注释正是在解释「不要用 emerald-500」。
 * 所以只看代码行，不看注释行。
 */
function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function walk(dir: string, out: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/*
 * 图表不许写死十六进制颜色。
 *
 * 上面那条只认调色板**类名**，挡不住 SVG 属性里的色值：首页流量图的
 * stroke="#10b981" / "#f59e0b" 就是从这个缝里漏过去的 —— 类名清干净了，
 * 图还是 emerald 和 amber，深色模式下也不跟着变。
 */
const HEX_COLOR = /#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?\b/i;

test("图表里不写死十六进制颜色", () => {
  const root = path.resolve(import.meta.dirname);
  const offenders: string[] = [];
  for (const dir of ["components/charts", "features/dashboard"]) {
    for (const file of walk(path.join(root, dir))) {
      const lines = stripComments(fs.readFileSync(file, "utf8")).split("\n");
      lines.forEach((line, index) => {
        // url(#gradientId) 是引用，不是颜色。
        if (HEX_COLOR.test(line.replace(/url\(#[^)]*\)/g, ""))) offenders.push(`${path.relative(root, file)}:${index + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, [], `图表颜色走 lib/chartPalette（var(--fx-*)）：\n  ${offenders.join("\n  ")}`);
});

test("界面里不出现调色板名字，颜色一律走语义令牌", () => {
  const root = path.resolve(import.meta.dirname);
  const offenders: string[] = [];
  for (const file of walk(root)) {
    const lines = stripComments(fs.readFileSync(file, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (PATTERN.test(line)) offenders.push(`${path.relative(root, file)}:${index + 1}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `这些地方还在写调色板名字。改成语义令牌：\n` +
      `  正常 var(--fx-healthy) / 降级 var(--fx-warn) / 故障 var(--fx-down)\n` +
      `  待命 var(--fx-standby) / 路径 var(--fx-path) / 交付 var(--fx-delivery)\n` +
      `  文字用 -text 那一档，浅底用 -soft；深浅色两套值令牌里都有，不用再写 dark:\n` +
      `纯装饰不该有颜色，走中性：\n  ${offenders.join("\n  ")}`,
  );
});
