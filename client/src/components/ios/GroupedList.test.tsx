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

test("分组只有一块白面，行自己不是面，而且只有这块面描一圈弱线", () => {
  /*
    「不是所有信息都需要一个圆角矩形」—— 组是那块面，行不是。
    页面是白纸，面靠一圈 1px 的弱线成形；行与行之间只有分隔线，行自己不描框。
  */
  const html = renderToStaticMarkup(
    <ListSection>
      <ListRow label="A" onSelect={noop} />
      <ListRow label="B" onSelect={noop} />
    </ListSection>,
  );
  assert.equal(html.match(/rounded-\[var\(--fx-radius-surface\)\]/g)?.length, 1);
  const classLists = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1].split(/\s+/));
  const framed = classLists.filter((list) => list.includes("border"));
  assert.equal(framed.length, 1, "只有分组这一块面描线");
  assert.ok(framed[0].includes("border-[var(--fx-stroke-weak)]"), "线用最弱那一档");
});

test("选中的行：字重 + 和应用侧栏同一个选中灰，读屏也知道是哪一项", () => {
  /*
    原来只靠字重。放到设置页宽屏的左栏里一量：旁边就是应用自己的侧栏，那边选中项是
    一块灰底，这边只是字粗一点 —— 同一件事两种说法，而且只靠字重在一列六个字里不好找。
  */
  const selected = renderToStaticMarkup(<ListRow label="系统配置" onSelect={noop} selected />);
  assert.match(selected, /font-semibold/);
  assert.match(selected, /bg-\[var\(--fx-hover\)\]/);
  assert.match(selected, /aria-current="true"/);

  const normal = renderToStaticMarkup(<ListRow label="系统配置" onSelect={noop} />);
  assert.doesNotMatch(normal, /font-semibold/);
  assert.doesNotMatch(normal, /aria-current/);
  // 没选中的行只有悬停时才有这层灰
  assert.doesNotMatch(normal.replace(/hover:bg-\[var\(--fx-hover\)\]/g, ""), /bg-\[var\(--fx-hover\)\]/);
});

test("当侧栏导航用时不画箭头；默认还是画", () => {
  const rail = renderToStaticMarkup(<ListRow label="系统配置" onSelect={noop} chevron={false} />);
  assert.doesNotMatch(rail, /lucide-chevron-right/);
  const index = renderToStaticMarkup(<ListRow label="系统配置" onSelect={noop} />);
  assert.match(index, /lucide-chevron-right/);
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
