import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { getPanelChangelogUrl, getPanelUpgradeProgress } from "./panelUpgrade";

const enabledAccelerator = {
  enabled: true,
  panelUpdateEnabled: true,
  url: "https://mirror.example.com",
};

test("builds a direct changelog URL unless panel update acceleration is fully enabled", () => {
  const directUrl = "https://github.com/zhongyizhu11-jpg/Forwardx/releases/tag/v2.3.275";

  assert.equal(getPanelChangelogUrl("2.3.275"), directUrl);
  assert.equal(
    getPanelChangelogUrl("2.3.275", null, { ...enabledAccelerator, panelUpdateEnabled: false }),
    directUrl,
  );
  assert.equal(
    getPanelChangelogUrl("2.3.275", null, { ...enabledAccelerator, enabled: false }),
    directUrl,
  );
  assert.equal(
    getPanelChangelogUrl("2.3.275", null, { ...enabledAccelerator, url: "not-a-url" }),
    directUrl,
  );
});

test("accelerates generated and supplied GitHub release URLs", () => {
  const releaseUrl = "https://github.com/zhongyizhu11-jpg/Forwardx/releases/tag/v2.3.275";
  const acceleratedUrl = `https://mirror.example.com/${releaseUrl}`;

  assert.equal(getPanelChangelogUrl("2.3.275", null, enabledAccelerator), acceleratedUrl);
  assert.equal(getPanelChangelogUrl(null, releaseUrl, enabledAccelerator), acceleratedUrl);
});


/*
  升级进度原来有两份实现（侧边栏一份、设置页一份），而且已经漂了。
  下面第一条就是当时能同时看见的那个分歧场景。
*/

const 升级中 = (...logs: string[]) => ({ status: "running", mode: "upgrade", logs });

test("Docker 构建打出 transferring context 时，只有一个答案", () => {
  // 这行是 docker build 必然会打的。原来侧边栏算 52%「下载或拉取资产」，
  // 设置页算 74%「安装并重启」—— 你在设置页升级时侧边栏就在旁边，两个数同时在屏幕上。
  const progress = getPanelUpgradeProgress(升级中("开始升级面板", "Docker image 构建", "=> transferring context: 2.1kB"));
  assert.equal(progress.percent, 74);
  assert.equal(progress.label, "安装并重启");
  assert.deepEqual(progress.steps.map((step) => step.done), [true, true, true, false]);
});

test("pnpm 安装的日志特征也认（原来只有设置页认）", () => {
  for (const line of ["Packages: +812", "写入 node_modules", "transferring context"]) {
    const progress = getPanelUpgradeProgress(升级中("开始升级", "panel bundle 已就绪", line));
    assert.equal(progress.steps[2].done, true, `${line} 应当算作「下载或拉取资产」完成`);
  }
});

test("各个状态给出的进度", () => {
  assert.deepEqual(
    getPanelUpgradeProgress({ status: "idle", mode: "upgrade", logs: [] }),
    { percent: 0, label: "等待升级", steps: [
      { label: "准备升级", done: false, active: false },
      { label: "检查发布资产", done: false, active: false },
      { label: "下载或拉取资产", done: false, active: false },
      { label: "安装并重启", done: false, active: false },
    ] },
  );

  const success = getPanelUpgradeProgress({ status: "success", mode: "upgrade", logs: [] });
  assert.equal(success.percent, 100);
  assert.equal(success.label, "升级完成，正在等待面板恢复");
  assert.ok(success.steps.every((step) => step.done));

  const waiting = getPanelUpgradeProgress({ status: "waiting_assets", mode: "upgrade", logs: [] });
  assert.equal(waiting.percent, 34);
  assert.equal(waiting.label, "等待 GitHub Actions 构建发布资产");

  const failed = getPanelUpgradeProgress({ status: "error", mode: "upgrade", logs: ["开始升级"] });
  assert.equal(failed.label, "升级异常");
  assert.ok(failed.percent >= 10);
});

test("回退用的是回退的说法，不是升级", () => {
  assert.equal(getPanelUpgradeProgress({ status: "idle", mode: "rollback", logs: [] }).label, "等待回退");
  assert.equal(getPanelUpgradeProgress({ status: "success", mode: "rollback", logs: [] }).label, "回退完成，正在等待面板恢复");
  assert.equal(getPanelUpgradeProgress({ status: "error", mode: "rollback", logs: [] }).label, "回退异常");
});

test("job 为空也要有说法，不能炸", () => {
  assert.equal(getPanelUpgradeProgress(null).percent, 0);
  assert.equal(getPanelUpgradeProgress(undefined).label, "等待升级");
  // logs 不是数组（服务端字段缺失时会这样）也不能炸
  assert.equal(getPanelUpgradeProgress({ status: "running", logs: "不是数组" as never }).percent, 12);
});

test("升级进度只有一处实现", () => {
  /*
    这条是防复发的。两份实现漂了多久没人知道 —— 因为两边各自看都「对」，
    只有并排摆出来才看得出分歧。步骤文案在源码里出现超过一次，就说明又抄了一份。
  */
  const root = path.resolve(import.meta.dirname, "..");
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(item.name) && !/\.test\.tsx?$/.test(item.name)) {
        if (fs.readFileSync(full, "utf8").includes("下载或拉取资产")) hits.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, ["lib/panelUpgrade.ts"], `升级进度的步骤文案出现在多个文件里，说明逻辑又被抄了一份：\n  ${hits.join("\n  ")}`);
});
