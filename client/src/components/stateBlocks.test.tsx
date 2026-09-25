import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import DataSectionError from "./DataSectionError";
import DataSectionLoading from "./DataSectionLoading";
import EmptyState from "./EmptyState";

/**
 * 加载中、没有、没读到 —— 三种状态各一个组件，而且都是「一块 surface，不描边」。
 *
 * 原来加载块是 rounded-lg + border + bg-card，放进卡片里就是卡中卡；出错块是红色描边框；
 * 空状态全站五种写法。这里守的是：三个组件都不再带边框，空状态的图标不再套一个描边小方块。
 */

test("加载块：一块白底，不描边", () => {
  const html = renderToStaticMarkup(<DataSectionLoading label="正在加载主机" />);
  assert.match(html, /role="status"/);
  assert.match(html, /bg-\[var\(--fx-l1-surface\)\]/);
  assert.doesNotMatch(html, /(?<![\w-])border(?![\w-])|border-border/);
  assert.match(html, /正在加载主机/);
});

test("出错块：一块浅红底，不描边；说是什么没读到，给重试", () => {
  const html = renderToStaticMarkup(<DataSectionError label="主机列表" error={new Error("boom")} onRetry={() => {}} />);
  assert.match(html, /bg-\[var\(--fx-down-soft\)\]/);
  assert.doesNotMatch(html, /border-destructive/);
  assert.match(html, /主机列表加载失败/);
  assert.match(html, /重试/);
});

test("空状态：标题 + 说明 + 操作；图标不再套描边小方块", () => {
  const html = renderToStaticMarkup(
    <EmptyState icon={<svg data-icon="x" />} title="暂无公告" description="当前没有可查看的公告。" actions={<button type="button">新建</button>} />,
  );
  assert.match(html, /class="empty-state"/);
  assert.match(html, /<h2>暂无公告<\/h2>/);
  assert.match(html, /当前没有可查看的公告。/);
  assert.match(html, /<button type="button">新建<\/button>/);

  const css = fs.readFileSync(path.resolve(import.meta.dirname, "../styles/workspace.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const iconRule = css.match(/\.empty-state-icon\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.doesNotMatch(iconRule, /border/, "图标那一格不描边");
  const blockRule = css.match(/\.empty-state\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(blockRule, /background:\s*var\(--fx-l1-surface\)/, "空状态自己是一块 surface");
  assert.match(blockRule, /border:\s*1px solid var\(--fx-stroke-weak\)/, "白纸上靠一圈弱线成形，和卡片同一种线");
});

test("全站不再用整张带标题的卡片、虚线框当空状态", () => {
  /*
    这一轮换掉的就是这两种：`<CardTitle>暂无…</CardTitle>` 和
    `border-dashed … 暂无…`。以后再有人这么写，这里会报出来。
  */
  const root = path.resolve(import.meta.dirname, "..");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
        const source = fs.readFileSync(full, "utf8");
        source.split("\n").forEach((line, index) => {
          if (/<CardTitle[^>]*>[^<]*(暂无|还没有)/.test(line) || /border-dashed[^"]*"[^>]*>\s*(暂无|还没有)/.test(line)) {
            offenders.push(`${path.relative(root, full)}:${index + 1}`);
          }
        });
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});
