// 附加的 node:test reporter：跑完后在末尾把失败的用例集中列出来。
// 完整 TAP 有上万行，CI 日志只取尾部时看不到失败在哪。
export default async function* failureSummary(source) {
  const failures = [];
  for await (const event of source) {
    if (event.type !== "test:fail") continue;
    const { name, file, line, details } = event.data;
    if (details?.type === "suite") continue;
    const error = details?.error;
    const cause = error?.cause ?? error;
    const message = String(cause?.message ?? cause ?? "").split("\n").slice(0, 12).join("\n    ");
    failures.push(`✖ ${name}\n    at ${file ?? "?"}:${line ?? "?"}\n    ${message}`);
  }
  if (failures.length === 0) return;
  yield `\n# ---- ${failures.length} failing test(s) ----\n${failures.join("\n")}\n`;
}
