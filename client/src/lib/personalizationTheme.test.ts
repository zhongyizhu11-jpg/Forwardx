import assert from "node:assert/strict";
import test from "node:test";
import { applyPersonalizationTheme, clearPersonalizationTheme } from "./personalizationTheme";

/**
 * 2.3.375 把主按钮、选中的分段项 / chip / 侧栏项、开关都换成了 --fx-primary-gradient，
 * 配色预设却只改强调色 —— 选了薰衣草，链接和图标变紫，按钮还是天蓝。这里守着：
 * 换预设时主色控件那组令牌跟着换，回到「面板默认」时全部撤掉、让令牌文件生效。
 */
function fakeRoot(dark = false) {
  const props = new Map<string, string>();
  const attrs = new Map<string, string>();
  const root = {
    style: {
      setProperty: (name: string, value: string) => { props.set(name, value); },
      removeProperty: (name: string) => { props.delete(name); },
    },
    classList: { contains: (name: string) => dark && name === "dark" },
    setAttribute: (name: string, value: string) => { attrs.set(name, value); },
    removeAttribute: (name: string) => { attrs.delete(name); },
  };
  return { root: root as unknown as HTMLElement, props, attrs };
}

const PRIMARY_CONTROL_VARS = [
  "--fx-primary-gradient",
  "--fx-primary-gradient-hover",
  "--fx-primary-fill",
  "--fx-primary-fill-hover",
  "--fx-primary-text",
  "--fx-primary-stroke",
  "--fx-primary-shadow",
];

test("选了薰衣草：按钮的渐变、字色、描边都换成薰衣草", () => {
  const { root, props, attrs } = fakeRoot();
  applyPersonalizationTheme("lavender", root);
  for (const name of PRIMARY_CONTROL_VARS) assert.ok(props.has(name), name);
  assert.equal(
    props.get("--fx-primary-gradient"),
    "linear-gradient(135deg, color-mix(in oklab, #6e56cf 65%, white) 0%, #6e56cf 100%)",
  );
  assert.equal(props.get("--fx-primary-fill"), "#6e56cf");
  assert.equal(props.get("--fx-primary-text"), "#ffffff");
  assert.match(props.get("--fx-primary-stroke") || "", /#6e56cf/);
  assert.equal(attrs.get("data-personalization-theme"), "lavender");
});

test("深色下用预设的深色主色和字色（松石深色是浅青底、深字）", () => {
  const { root, props } = fakeRoot(true);
  applyPersonalizationTheme("teal", root);
  assert.equal(
    props.get("--fx-primary-gradient"),
    "linear-gradient(135deg, oklch(0.72 0.14 180) 0%, color-mix(in oklab, oklch(0.72 0.14 180) 75%, black) 100%)",
  );
  assert.equal(props.get("--fx-primary-text"), "oklch(0.12 0.02 190)");
});

test("墨色：渐变从主色（正文色）推，按钮反黑", () => {
  const { root, props } = fakeRoot();
  applyPersonalizationTheme("mono", root);
  assert.equal(props.get("--fx-primary-fill"), "var(--fx-text)");
  assert.equal(props.get("--fx-primary-text"), "var(--fx-text-inverse)");
});

test("换回面板默认：主色控件的变量全部撤掉，令牌文件里的天蓝渐变生效", () => {
  const { root, props } = fakeRoot();
  applyPersonalizationTheme("sakura", root);
  assert.ok(props.size > 0);
  applyPersonalizationTheme("ink", root);
  for (const name of [...PRIMARY_CONTROL_VARS, "--fx-mesh-1", "--fx-accent", "--primary"]) {
    assert.equal(props.has(name), false, name);
  }
});

test("clearPersonalizationTheme 也撤掉主色控件的变量", () => {
  const { root, props, attrs } = fakeRoot();
  applyPersonalizationTheme("forest", root);
  clearPersonalizationTheme(root);
  assert.equal(props.size, 0);
  assert.equal(attrs.has("data-personalization-theme"), false);
});
