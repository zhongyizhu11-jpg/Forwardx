import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingList, SettingRow } from "./SettingRow";

test("一行设置：名字和说明在左、控件在右，不画框，行间那条线和分组列表是同一条", () => {
  const html = renderToStaticMarkup(
    <SettingList>
      <SettingRow label="开放注册" description="关闭后仅管理员可添加用户。" control={<input type="checkbox" aria-label="开放注册" />} />
      <SettingRow label="启用 2FA 软件支持" control={<input type="checkbox" aria-label="启用 2FA 软件支持" />} />
    </SettingList>,
  );
  assert.equal(html.match(/fx-list-row/g)?.length, 2);
  assert.match(html, /开放注册[^]*关闭后仅管理员可添加用户。[^]*type="checkbox"/);
  // 反向对照：换掉的正是这种「一个开关一个小框」
  assert.doesNotMatch(html, /rounded-lg|border-border|bg-muted/);
});

test("说明用 span 不用 p：手机上 .workspace-main p 会给每段加上下 12px", () => {
  const html = renderToStaticMarkup(<SettingRow label="a" description="b" />);
  assert.doesNotMatch(html, /<p[\s>]/);
  // 反向对照：确实有那条会撑高的规则，这条约束才有意义
  const css = fs.readFileSync(path.resolve(import.meta.dirname, "../styles/workspace.css"), "utf8");
  assert.match(css, /\.workspace-main p \{ margin-block: 12px; \}/);
});

test("asLabel 时整行是 label（点名字就是点开关），默认不是", () => {
  const asLabel = renderToStaticMarkup(<SettingRow asLabel label="启用 DDNS" control={<button type="button" role="checkbox" aria-checked="false" aria-label="启用 DDNS" />} />);
  assert.match(asLabel, /<label[^>]*cursor-pointer[^>]*>[^]*启用 DDNS[^]*role="checkbox"[^]*<\/label>/);

  // 控件是选择框时不能是 label：点名字会去开选择框
  const plain = renderToStaticMarkup(<SettingRow label="服务商" control={<select aria-label="服务商" />} />);
  assert.doesNotMatch(plain, /<label/);
});

test("这一项的参数跟在同一格里、在 label 外面（输入框不能被 label 包住）", () => {
  const html = renderToStaticMarkup(
    <SettingRow asLabel label="流量提醒" control={<input type="checkbox" aria-label="流量提醒" />}>
      <input aria-label="阈值" defaultValue="20" />
    </SettingRow>,
  );
  const labelEnd = html.indexOf("</label>");
  const thresholdAt = html.indexOf('aria-label="阈值"');
  assert.ok(labelEnd > 0 && thresholdAt > labelEnd, "阈值输入框在 label 之后");
  assert.equal(html.match(/fx-list-row/g)?.length, 1, "参数和开关是同一行，不单独起一条分隔线");
});
