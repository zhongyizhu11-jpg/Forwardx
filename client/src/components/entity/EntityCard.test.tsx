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

test("Entity 卡片是唯一画框的那一层，卡身不再套框", () => {
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
  // 整张卡一个边框
  assert.equal(html.match(/rounded-\[var\(--fx-radius-card\)\]/g)?.length, 1);
  // 卡身和指标组都不画边框 —— 上一版这里是三层嵌套的圆角矩形
  assert.doesNotMatch(html, /border border-\[var\(--fx-stroke-base\)\][^"]*"[^>]*>\s*<div[^>]*border border/);
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
