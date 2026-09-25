import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { EntityActions, partitionEntityActions, type EntityAction } from "./EntityActions";
import { EntityBody, EntityCard, EntityHeader, EntityTag } from "./EntityCard";
import { Metric, MetricGroup, ResourceMeter } from "./Metric";

const noop = () => {};
const action = (key: string, label: string, extra: Partial<EntityAction> = {}): EntityAction => ({
  key,
  label,
  onSelect: noop,
  ...extra,
});

test("Entity 卡片是唯一一层面，而且这层面只描一圈弱线", () => {
  const html = renderToStaticMarkup(
    <EntityCard>
      <EntityHeader health="healthy" title="DW TW" subtitle="Taiwan · 78.105.182.83" />
      <EntityBody>
        <MetricGroup>
          <Metric label="CPU" value="2" unit="%" />
        </MetricGroup>
      </EntityBody>
    </EntityCard>,
  );
  // 整张卡就一块白面，圆角只出现一次
  assert.equal(html.match(/rounded-\[var\(--fx-radius-surface\)\]/g)?.length, 1);
  /*
    页面和卡片都是白纸，卡片靠一圈 1px 的弱线成形 —— 而且线只画这一次：
    卡里不允许再出现四面围合的框，那是上一版三层嵌套圆角矩形的来源。
    分隔用的 border-t / border-y 不算围合，放行。
  */
  const classLists = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1].split(/\s+/));
  const framed = classLists.filter((list) => list.includes("border"));
  assert.equal(framed.length, 1, "只有卡片本身这一圈线");
  assert.ok(framed[0].includes("border-[var(--fx-stroke-weak)]"), "线用最弱那一档");
});

test("卡头一行里只有一个主角：名字是 primary，归属是 meta", () => {
  const html = renderToStaticMarkup(
    <EntityHeader health="healthy" title="DW TW" subtitle="Taiwan · 78.105.182.83" />,
  );
  assert.match(html, /text-primary-type[^"]*font-medium/);
  assert.match(html, /text-meta text-muted-foreground/);
  assert.match(html, /DW TW/);
  assert.match(html, /Taiwan/);
});

test("Metric 把数字放在标签和单位之前，不是「总延迟 8ms」一整串", () => {
  const html = renderToStaticMarkup(<Metric label="延迟" value="8" unit="毫秒" />);
  /*
    只比较文本节点的位置。第一版是在整段 HTML 里 indexOf("ms")，结果它先命中
    class 名里的 "tabular-nums" —— 断言量的是类名不是内容。
  */
  const text = html.replace(/<[^>]*>/g, "\u0000");
  const labelAt = text.indexOf("延迟");
  const valueAt = text.indexOf("8");
  const unitAt = text.indexOf("毫秒");
  assert.ok(labelAt >= 0 && valueAt > labelAt && unitAt > valueAt, "顺序应是 标签 → 值 → 单位");
  // 值走大字号并且等宽对齐
  assert.match(html, /text-metric[^"]*tabular-nums/);
});

test("拿不到资源数据时画「—」，不是 0%", () => {
  // 一台离线的机器 CPU 不是 0%，是不知道。写 0% 等于报了一个它没说过的数。
  const unknown = renderToStaticMarkup(<ResourceMeter label="CPU" percent={null} />);
  // 只看文本节点：style="width:0%" 不是显示给人看的那个 0%
  const unknownText = unknown.replace(/<[^>]*>/g, "\u0000");
  assert.match(unknownText, /—/);
  assert.doesNotMatch(unknownText, /0%/);

  const known = renderToStaticMarkup(<ResourceMeter label="CPU" percent={2} />);
  assert.match(known, /2%/);
});

test("资源条越界才变色，正常时是中性的", () => {
  // 一条永远是绿色的进度条等于没有颜色信息。
  const normal = renderToStaticMarkup(<ResourceMeter label="CPU" percent={20} />);
  assert.match(normal, /--fx-network-path-muted/);

  const warn = renderToStaticMarkup(<ResourceMeter label="RAM" percent={80} />);
  assert.match(warn, /--fx-health-warning/);

  const critical = renderToStaticMarkup(<ResourceMeter label="Disk" percent={95} />);
  assert.match(critical, /--fx-health-critical/);
});

test("一级操作最多两个，多出来的并进菜单而不是消失", () => {
  const parts = partitionEntityActions(
    [action("a", "诊断"), action("b", "重测"), action("c", "编辑"), action("d", "复制")],
  );
  assert.deepEqual(parts.shown.map((x) => x.label), ["诊断", "重测"]);
  // 第三、四个被挤进菜单，但一个都没丢
  assert.deepEqual(parts.safe.map((x) => x.label), ["编辑", "复制"]);

  // 外面那两个确实渲染出来了，菜单入口也在
  const html = renderToStaticMarkup(
    <EntityActions
      primary={[action("a", "诊断"), action("b", "重测"), action("c", "编辑")]}
    />,
  );
  assert.match(html, /诊断/);
  assert.match(html, /重测/);
  assert.match(html, /aria-label="更多操作"/);
});

test("破坏性操作永远排最后", () => {
  /*
    测纯函数而不是渲染结果：Radix 的菜单内容是 portal 出去的，关着的时候
    根本不在 DOM 里，靠 HTML 验证不了顺序。

    排序必须在组件里做，不能指望每个调用方都记得把删除放最后 ——
    忘一处的后果是有人误删。
  */
  const parts = partitionEntityActions([], [
    action("del", "删除", { destructive: true }),
    action("edit", "编辑"),
    action("dup", "复制"),
  ]);
  assert.deepEqual(parts.safe.map((x) => x.label), ["编辑", "复制"]);
  assert.deepEqual(parts.destructive.map((x) => x.label), ["删除"]);
});

test("多个破坏性操作之间保持调用方给的相对顺序", () => {
  const parts = partitionEntityActions([], [
    action("stop", "停用", { destructive: true }),
    action("edit", "编辑"),
    action("del", "删除", { destructive: true }),
  ]);
  assert.deepEqual(parts.destructive.map((x) => x.label), ["停用", "删除"]);
});

test("没有任何操作时分组是空的", () => {
  const parts = partitionEntityActions();
  assert.deepEqual(parts, { shown: [], safe: [], destructive: [] });
});

test("没有任何操作时不渲染那个空的 ··· 按钮", () => {
  const html = renderToStaticMarkup(<EntityActions />);
  assert.doesNotMatch(html, /更多操作/);
});

test("只有破坏性操作时，菜单入口仍然出现", () => {
  const html = renderToStaticMarkup(
    <EntityActions menu={[action("del", "删除", { destructive: true })]} />,
  );
  assert.match(html, /aria-label="更多操作"/);
});

test("属性标记和状态徽标长得不一样，眼睛要能分出哪个是状态", () => {
  const tag = renderToStaticMarkup(<EntityTag>iptables</EntityTag>);
  // 属性标记走控件圆角，状态徽标走胶囊 —— 形状本身就是区分线索
  assert.match(tag, /--fx-radius-control/);
  assert.doesNotMatch(tag, /--fx-radius-pill/);
});

test("组件里不出现调色板颜色，只出现语义令牌", () => {
  const html = renderToStaticMarkup(
    <EntityCard>
      <EntityHeader health="down" title="55" subtitle="Offline" />
      <EntityBody>
        <ResourceMeter label="CPU" percent={95} />
      </EntityBody>
    </EntityCard>,
  );
  assert.doesNotMatch(html, /emerald|amber-\d|#[0-9a-fA-F]{6}/);
  assert.match(html, /var\(--fx-/);
});

test("外面的操作念得出是哪一条：看得见的字是「编辑」，读屏念「编辑隧道 X」，而且以看得见的字开头", () => {
  const html = renderToStaticMarkup(
    <EntityActions primary={[{ key: "edit", label: "编辑", ariaLabel: "编辑隧道 HK -> JP", onSelect: () => {} }]} />,
  );
  assert.match(html, /aria-label="编辑隧道 HK -&gt; JP"[^>]*>编辑</);
});

test("卡片底部的操作区只画一条细线，不给底色", async () => {
  const { CardActions } = await import("./EntityCard");
  const html = renderToStaticMarkup(<CardActions><span>x</span></CardActions>);
  assert.match(html, /class="fx-card-actions[^"]*border-t border-\[var\(--fx-stroke-weak\)\]/);
  assert.doesNotMatch(html, /bg-/);
});
