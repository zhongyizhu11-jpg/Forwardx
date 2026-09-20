import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 账户面板做了两份：侧边栏的账户菜单（`DashboardLayout`）和个人资料页（`Profile`）。
 *
 * 两边各自定义了同名的 7 个 mutation 和 5 个处理函数，一百多行几乎一样。
 * 而且**已经漂了**：
 *
 *   - `handleSaveAvatar`：个人资料页点保存前先查今天的额度，侧边栏没有 ——
 *     用户挑完裁完点保存，才被服务端顶回来。（已修：额度判断收进
 *     `lib/avatarQuota.ts`，两边共用。）
 *   - `handleMobileUpdateCheck`：两边的「在途判断 / 状态 / 没更新怎么说 /
 *     出错怎么说」逐字一样，改一句另一处就留在旧文案上。（已修：收进
 *     `lib/mobileAppUpdateCheck.ts`。**发现新版本之后怎么呈现没有一起收**，
 *     那两边是故意不同的：侧边栏是弹层、塞不下版本对比，所以弹带「前往下载」
 *     的对话框；个人资料页是整页，检查完在卡片里常驻显示版本对比和下载按钮，
 *     不打断用户。顺带删掉了那边一个写了从来没人读的 sessionStorage 键。）
 *
 * 这条测试不修问题，只**把账记住**：名单只许变短。再多抄一个同名处理函数就红，
 * 逼人先想清楚是不是该抽出去共用。
 */

const ROOT = path.resolve(import.meta.dirname);
const 侧边栏 = path.join("components", "DashboardLayout.tsx");
const 个人资料页 = path.join("pages", "Profile.tsx");

/*
  已知重复的处理函数，一处一行。名单只许变短：
  抽出去共用之后从这里删掉，删不掉说明没真抽。
*/
const 已知重复: readonly string[] = [
  "handleChangePassword",
  "handleDisableTwoFactor",
  "handleEnableTwoFactor",
  "handleSaveAvatar",
];

const DECL = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]{0,200})?=\s*(?:async\s*)?(?:\([^)]{0,400}\)|[A-Za-z_$][\w$]*)\s*(?::[^=>]{0,200})?=>/g;

function declaredNames(relative: string) {
  const source = fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const names = new Set<string>();
  for (const match of source.matchAll(DECL)) {
    const name = match[1] ?? match[2];
    const brace = source.indexOf("{", match.index! + match[0].length - 1);
    if (brace < 0 || brace - (match.index! + match[0].length) > 8) continue;   // 单表达式箭头函数
    names.add(name);
  }
  return names;
}

test("账户面板的重复只许变少", () => {
  const 侧 = declaredNames(侧边栏);
  const 个 = declaredNames(个人资料页);
  assert.ok(侧.size >= 20 && 个.size >= 8, `只扫到 ${侧.size} / ${个.size} 个函数，扫描逻辑可能失效了`);   // 实测 26 / 9

  const 重复 = [...侧].filter((name) => 个.has(name)).sort();
  const 新增 = 重复.filter((name) => !已知重复.includes(name));
  assert.deepEqual(
    新增,
    [],
    `账户面板又多抄了一份同名处理函数。这两个文件里的账户逻辑本来就重复了一百多行，\n`
      + `而且已经漂出过真问题（头像额度只有一边判）。抽出去共用，别再加：\n  `
      + 新增.join("\n  "),
  );

  const 已经不重复了 = 已知重复.filter((name) => !重复.includes(name));
  assert.deepEqual(
    已经不重复了,
    [],
    `这些已经不重复了，请从「已知重复」名单里删掉：\n  ${已经不重复了.join("\n  ")}`,
  );
});

test("头像额度两边用同一套算法", () => {
  // 这一条是上面那笔账里已经还掉的部分，别再退回去各写各的
  for (const relative of [侧边栏, 个人资料页]) {
    const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
    assert.match(source, /avatarQuotaState\(/, `${relative} 没有用共用的额度判断`);
    assert.doesNotMatch(
      source.replace(/\/\*[\s\S]*?\*\//g, ""),
      /remaining\s*\?\?\s*3/,
      `${relative} 又把额度默认值抄了一遍`,
    );
  }
});
