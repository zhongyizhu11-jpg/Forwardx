import fs from "node:fs";

/**
 * 从 CHANGELOG 里取出这次发布要贴到 Release 页面上的说明。
 *
 * 为什么要能取多节：发布说明该覆盖的是**自上一次发布以来**的全部改动，而不是
 * 「最后一次版本号 +1 里写了什么」。连着合两个 PR 才发一次版是常态（真实发生过：
 * 上一个 Release 是 v2.3.320，main 已经到 v2.3.338，中间十八个版本一句话都不会
 * 出现在发布说明里）—— 那种发布说明会让人以为这一版只改了它最后碰的那一处。
 *
 * 用法：
 *   node scripts/extract-release-notes.mjs 2.3.338            # 只取这一节
 *   node scripts/extract-release-notes.mjs 2.3.338 2.3.320    # 取 321..338 全部
 *
 * 第二个参数是**上一个已发布版本**（不含它自己）。解析不出来时退回只取一节 ——
 * 发布说明不完整是小事，为它挡住一次发布是大事。
 */

const versionArg = process.argv[2] || "";
const sinceArg = process.argv[3] || "";
const version = versionArg.trim().replace(/^v/i, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Invalid release version: ${versionArg || "<empty>"}`);
  process.exit(1);
}

// 路径可以覆盖，纯粹为了能拿一份固定的 CHANGELOG 去测 —— 否则用例会跟着仓库
// 真实的版本号一起漂，每发一版就得改一次期望值。
const changelogPath = process.env.FORWARDX_CHANGELOG_PATH
  ? new URL(process.env.FORWARDX_CHANGELOG_PATH, `file://${process.cwd()}/`)
  : new URL("../CHANGELOG.md", import.meta.url);
const changelog = fs.readFileSync(changelogPath, "utf8");

/** CHANGELOG 里的每一节，按文件顺序（约定是新版本在前）。 */
function sectionsOf(text) {
  const pattern = /^## \[(\d+\.\d+\.\d+)\][^\n]*$/gm;
  const marks = [];
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    marks.push({ version: match[1], headStart: match.index, bodyStart: match.index + match[0].length });
  }
  return marks.map((mark, index) => ({
    version: mark.version,
    body: text.slice(mark.bodyStart, index + 1 < marks.length ? marks[index + 1].headStart : text.length).trim(),
  }));
}

const sections = sectionsOf(changelog);
const targetIndex = sections.findIndex((section) => section.version === version);
if (targetIndex < 0) {
  console.error(`CHANGELOG section for ${version} was not found`);
  process.exit(1);
}

const since = sinceArg.trim().replace(/^v/i, "");
let endIndex = targetIndex + 1;
if (since && since !== version) {
  const sinceIndex = sections.findIndex((section) => section.version === since);
  if (sinceIndex < 0) {
    console.error(`[warn] previous release ${since} not found in CHANGELOG, falling back to a single section`);
  } else if (sinceIndex <= targetIndex) {
    // 上一个发布比这次还新（回滚、重跑旧 tag）—— 说不清范围，就只写这一节。
    console.error(`[warn] previous release ${since} is not older than ${version}, falling back to a single section`);
  } else {
    endIndex = sinceIndex;
  }
}

const picked = sections.slice(targetIndex, endIndex);
if (picked.length === 1) {
  // 单节维持原样：自己那一页上再加一个自己的版本号标题是废话。
  const body = picked[0].body;
  if (!body) {
    console.error(`CHANGELOG section for ${version} is empty`);
    process.exit(1);
  }
  process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
} else {
  const oldest = picked[picked.length - 1].version;
  const parts = [
    `> 这次发布包含 v${oldest} → v${version} 共 ${picked.length} 个版本（上一个发布是 v${since}）。`,
    "",
    ...picked.flatMap((section) => [`## v${section.version}`, "", section.body, ""]),
  ];
  process.stdout.write(`${parts.join("\n").trim()}\n`);
}
