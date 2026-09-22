import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { GroupedList, ListRow, ListSection } from "./GroupedList";

const noop = () => {};

test("可点的行画箭头，不可点的不画", () => {
  const tappable = renderToStaticMarkup(<ListRow label="IP Stack" onSelect={noop} />);
  assert.match(tappable, /lucide-chevron-right/);
  assert.match(tappable, /<button/);

  const plain = renderToStaticMarkup(<ListRow label="IP Stack" />);
  assert.doesNotMatch(plain, /lucide-chevron-right/);
  assert.doesNotMatch(plain, /<button/);
});

test("一行里不能既是入口又是开关：有 trailing 就不画箭头", () => {
  /*
    两个都画的话用户不知道点哪儿 —— 点开关还是进下一层？
    iOS 上这两种行从来不混，这条硬性挡住。
  */
  const html = renderToStaticMarkup(
    <ListRow label="不作为默认路由" trailing={<span>switch</span>} onSelect={noop} />,
  );
  assert.doesNotMatch(html, /lucide-chevron-right/);
  assert.match(html, /switch/);
});

test("右侧的值渲染出来，和名称分居两侧", () => {
  const html = renderToStaticMarkup(<ListRow label="网络接口" value="Auto" onSelect={noop} />);
  const text = html.replace(/<[^>]*>/g, "\u0000");
  assert.ok(text.indexOf("网络接口") < text.indexOf("Auto"));
});

test("有图标的行带内缩标记，没图标的不带", () => {
  // 分隔线从文字开始画靠这个类，图标那一列才能保持连续。
  const withIcon = renderToStaticMarkup(<ListRow icon={<span>i</span>} label="节点" onSelect={noop} />);
  assert.match(withIcon, /fx-list-row-inset/);

  const without = renderToStaticMarkup(<ListRow label="节点" onSelect={noop} />);
  assert.doesNotMatch(without, /fx-list-row-inset/);
});

test("禁用的行不是按钮，点不动", () => {
  const html = renderToStaticMarkup(<ListRow label="节点" onSelect={noop} disabled />);
  assert.doesNotMatch(html, /<button(?![^>]*disabled)/);
});

test("分组的小标题和脚注都渲染出来", () => {
  const html = renderToStaticMarkup(
    <ListSection header="节点" footer="指定的 IP 范围将绕过 TUN。">
      <ListRow label="所有节点" onSelect={noop} />
    </ListSection>,
  );
  assert.match(html, /节点/);
  assert.match(html, /绕过 TUN/);
});

test("分组只画一层框，行自己不画框", () => {
  // 「不是所有信息都需要一个圆角矩形」—— 组是那个框，行不是。
  const html = renderToStaticMarkup(
    <ListSection>
      <ListRow label="A" onSelect={noop} />
      <ListRow label="B" onSelect={noop} />
    </ListSection>,
  );
  assert.equal(html.match(/rounded-\[var\(--fx-radius-card\)\]/g)?.length, 1);
});

test("选中的行靠字重标出来，不靠底色", () => {
  const selected = renderToStaticMarkup(<ListRow label="系统配置" onSelect={noop} selected />);
  assert.match(selected, /font-semibold/);

  const normal = renderToStaticMarkup(<ListRow label="系统配置" onSelect={noop} />);
  assert.doesNotMatch(normal, /font-semibold/);
});

test("组与组之间的间距比组内行距大一档", () => {
  /*
    iOS 上这个间距是「这两组不是一类」的唯一线索。和行距一样大的话，
    十几行会糊成一片。
  */
  const html = renderToStaticMarkup(
    <GroupedList>
      <ListSection header="A"><ListRow label="a" /></ListSection>
      <ListSection header="B"><ListRow label="b" /></ListSection>
    </GroupedList>,
  );
  assert.match(html, /gap-\[var\(--fx-space-6\)\]/);
});

test("行里不出现调色板颜色，只有语义令牌", () => {
  const html = renderToStaticMarkup(
    <ListSection header="节点">
      <ListRow icon={<span>i</span>} label="所有节点" value="12" onSelect={noop} />
    </ListSection>,
  );
  assert.doesNotMatch(html, /emerald|amber-\d|#[0-9a-fA-F]{6}/);
});
