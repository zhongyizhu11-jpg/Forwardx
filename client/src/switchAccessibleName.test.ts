import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 每个开关都要说得出自己是干什么的。
 *
 * 开关在读屏里念出来是「switch, checked」—— 名字不来自旁边那行字，除非显式关联。
 * 设置页一度有 11 个开关全无名称：读屏用户连着听到十一声「switch, checked」，
 * 分不清哪个是「开放注册」哪个是「启用 HTTPS」。
 *
 * 三种关联方式都算数：
 *   - `aria-label="..."`（最常用）
 *   - `aria-labelledby="..."`
 *   - `id="..."` 配一个 `<Label htmlFor>`（插件页用的就是这种）
 *
 * 这是**源码级**检查，不开浏览器，所以跑得起也拦得住新增的漏网。
 * 代价是它认不出「id 有了但没人 htmlFor 它」这种情况 —— 那一层由真面板走查兜。
 */

const ROOT = path.resolve(import.meta.dirname);

function collectTsx(dir: string, out: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTsx(full, out);
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** 从 `<Switch` 起，把整个标签（到自闭合的 `/>`）取出来。 */
function tagTextAt(lines: string[], start: number) {
  const chunk: string[] = [];
  for (let i = start; i < Math.min(lines.length, start + 20); i += 1) {
    chunk.push(lines[i]);
    if (lines[i].includes("/>") || lines[i].includes("</Switch>") || lines[i].includes("</OptimisticSwitch>")) break;
  }
  return chunk.join("\n");
}

/*
  还没补名字的开关，一处一行。

  这是**棘轮**不是豁免：名单只许变短。新写的开关漏了名字会直接红，
  名单里的补好了就从这里删掉 —— 删不掉说明没真补。

  为什么不一次补完：这些开关的名字得一处一处看上下文定。脚本按「最近的中文」
  自动提名试过了，一半提出来的是说明文字而不是名字（「低于阈值时提醒。」这种
  做可访问名称是错的，WCAG 要的是和可见标签一致）。硬套上去比没有更糟 ——
  读屏用户听到一句和界面对不上的话，反而更难定位。
*/
const 待补: readonly string[] = [
  "App.tsx:121",
  "App.tsx:57",
  "components/MobileAppSettings.tsx:120",
  "components/MobileAppSettings.tsx:92",
  "components/TrafficBillingConfigManager.tsx:625",
  "components/TrafficBillingConfigManager.tsx:632",
  "components/hosts/HostGroupManager.tsx:534",
  "components/hosts/HostProbeServiceManager.tsx:625",
  "components/hosts/HostTrafficBillingDialog.tsx:200",
  "components/plugins/AgentResourceManager.tsx:804",
  "components/proxy/ProxyInboundsSection.tsx:1295",
  "pages/ClientSubscriptions.tsx:1894",
  "pages/EmailSettings.tsx:203",
  "pages/EmailSettings.tsx:266",
  "pages/EmailSettings.tsx:274",
  "pages/EmailSettings.tsx:291",
  "pages/EmailSettings.tsx:299",
  "pages/ForwardGroups.tsx:2314",
  "pages/ForwardGroups.tsx:2366",
  "pages/ForwardGroups.tsx:2456",
  "pages/ForwardGroups.tsx:2460",
  "pages/ForwardGroups.tsx:2499",
  "pages/ForwardGroups.tsx:2665",
  "pages/ForwardGroups.tsx:2669",
  "pages/ForwardGroups.tsx:2828",
  "pages/ForwardGroups.tsx:2864",
  "pages/ForwardGroups.tsx:2868",
  "pages/ForwardGroups.tsx:2905",
  "pages/Hosts.tsx:3242",
  "pages/Hosts.tsx:3246",
  "pages/Hosts.tsx:3250",
  "pages/Hosts.tsx:3453",
  "pages/Payments.tsx:538",
  "pages/Payments.tsx:589",
  "pages/Payments.tsx:635",
  "pages/Payments.tsx:680",
  "pages/Payments.tsx:739",
  "pages/Payments.tsx:772",
  "pages/Plans.tsx:1880",
  "pages/Plugins.tsx:370",
  "pages/Plugins.tsx:496",
  "pages/Setup.tsx:460",
  "pages/Tunnels.tsx:3882",
  "pages/Tunnels.tsx:3980",
  "pages/Tunnels.tsx:4106",
  "pages/Users.tsx:2449",
  "pages/Users.tsx:2453",
  "pages/Users.tsx:2457",
  "pages/Users.tsx:2461",
  "pages/Users.tsx:2465",
];

test("每个 Switch 都有可访问名称", () => {
  const offenders: string[] = [];
  let total = 0;
  for (const file of collectTsx(ROOT)) {
    // 组件自身的定义不算用法
    if (file.endsWith(path.join("ui", "switch.tsx"))) continue;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (!/<(Switch|OptimisticSwitch)[\s/>]/.test(lines[i])) continue;
      total += 1;
      const tag = tagTextAt(lines, i);
      const named = /\baria-label\b/.test(tag)
        || /\baria-labelledby\b/.test(tag)
        || /\bid=/.test(tag);
      if (!named) offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
    }
  }
  assert.ok(total >= 40, `只扫到 ${total} 个开关，扫描逻辑可能失效了`);
  const 新增 = offenders.filter((x) => !待补.includes(x));
  assert.deepEqual(
    新增,
    [],
    `新写的开关漏了可访问名称，读屏里只会念出「switch, checked」：\n  ${新增.join("\n  ")}`,
  );
  // 名单只许变短：补好了就从 待补 里删掉。
  const 已补好 = 待补.filter((x) => !offenders.includes(x));
  assert.deepEqual(
    已补好,
    [],
    `这些已经补上名字了，请从 待补 名单里删掉：\n  ${已补好.join("\n  ")}`,
  );
});
