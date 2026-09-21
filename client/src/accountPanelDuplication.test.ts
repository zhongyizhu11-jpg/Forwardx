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
 * 这里有两道闸：
 *
 *   1. **名单只许变短** —— 再多抄一个同名处理函数就红。
 *   2. **名单上的必须逐字一致** —— 两份同名函数悄悄漂开也红。
 *
 * 第 2 道是后补的，因为第 1 道盯不住内容：头像额度那次就是同名不同行为，
 * 名字对得上，棘轮一路绿。剩下这四个逐对比过，眼下**都还是一致的**
 * （差的只有一处尾逗号和一条注释），所以没有急着抽 —— 密码和两步验证是
 * 最不该冒险重构的地方，而「一漂开就红」已经把风险按住了。谁要动其中一处，
 * 这条会逼他把两处一起动，或者真的抽出去。
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

/**
 * 把一个处理函数的函数体整段取出来（从 `const 名字 =` 到配对的 `}`）。
 *
 * 取不到就让用例红，而不是当作「没有区别」—— 一个取不到东西的比对，
 * 会永远通过。
 */
function handlerBody(relative: string, name: string) {
  const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
  const start = source.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `${relative} 里找不到 ${name}，取函数体的逻辑该修了`);
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`${relative} 里 ${name} 的大括号没配上，取函数体的逻辑该修了`);
}

// 注释、换行、尾逗号都不算差异：一边写成一行、另一边拆成三行多个尾逗号，
// 做的是同一件事（两边现在就差这么一个逗号）。标识符、语句条数、顺序这些
// 实打实的差别都留得下来。
function normalizeBody(body: string) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/,(\s*[}\])])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

test("名单里的重复必须是**逐字**重复，不许悄悄漂开", () => {
  /*
    上面那条只盯名字，盯不住内容 —— 两份同名函数可以一点点漂开而它一直绿。
    头像额度那次就是这么漏过去的：个人资料页先查额度，侧边栏不查，名字一样，
    棘轮照样通过，用户挑完裁完点保存才被服务端顶回来。

    所以名单上的每一条都要求两边**归一化后完全一致**。哪天有人只改了一处，
    这里立刻红，逼他要么两处一起改，要么真的抽出去共用。
  */
  const 漂开了: string[] = [];
  for (const name of 已知重复) {
    const 侧 = handlerBody(侧边栏, name);
    const 个 = handlerBody(个人资料页, name);
    // 取岔了的话两边都会变成很短的片段，比对就失去意义
    assert.ok(
      侧.length > 80 && 个.length > 80,
      `${name} 取出来的函数体太短（${侧.length} / ${个.length} 字符），八成取岔了`,
    );
    if (normalizeBody(侧) !== normalizeBody(个)) 漂开了.push(name);
  }
  assert.deepEqual(
    漂开了,
    [],
    "这些同名处理函数两边已经不一样了 —— 同一个功能，两个入口，行为不同：\n  "
      + 漂开了.join("\n  ")
      + "\n要么两处一起改回一致，要么抽出去共用（抽完记得从「已知重复」名单里删掉）。",
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
