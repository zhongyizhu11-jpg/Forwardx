import { getPersonalizationThemePreset, linearGradient135, normalizePersonalizationThemePresetId, primaryGradientStops } from "@shared/personalization";

/*
  预设写到 <html> 上的变量。

  chart2～4 落到第 6～8 位（分类色），不再盖 --chart-2～4：那三位现在就是状态色
  （图表里的绿必须是列表里的绿），预设换的是强调色，不该把「正常」染成它的配色。
*/
const THEME_VAR_MAP = {
  primary: ["--primary", "--color-primary"],
  primaryForeground: ["--primary-foreground", "--color-primary-foreground"],
  ring: ["--ring", "--color-ring"],
  chart1: ["--chart-1", "--color-chart-1"],
  chart2: ["--chart-6", "--color-chart-6"],
  chart3: ["--chart-7", "--color-chart-7"],
  chart4: ["--chart-8", "--color-chart-8"],
  sidebarPrimary: ["--sidebar-primary", "--color-sidebar-primary"],
  sidebarPrimaryForeground: ["--sidebar-primary-foreground", "--color-sidebar-primary-foreground"],
  sidebarRing: ["--sidebar-ring", "--color-sidebar-ring"],
} as const;

/*
  强调色的三档也跟着预设走，否则换成紫藤之后按钮是紫的、侧栏选中项还是青的。
  字（--fx-accent）默认就用主色，主色太浅的预设自己给 accent；线用 ring；淡底从主色兑 12%。
  --fx-path / --fx-flow-in / --fx-focus-ring 在令牌里都指向 --fx-accent，不用单独写。
*/
const ACCENT_VARS = ["--fx-accent", "--fx-accent-strong", "--fx-accent-soft", "--fx-accent-fill", "--fx-accent-fill-foreground"] as const;

/*
  主色控件的那道渐变也跟着预设走。2.3.375 把主按钮、选中的分段项 / chip / 侧栏项、开关换成
  --fx-primary-gradient 之后，这里只改了强调色，换成薰衣草时按钮还是天蓝 —— 用户看到的就是「没生效」。
  渐变两端由主色推出来（见 shared/personalization.ts 的 primaryGradientStops），字色用预设的 primaryForeground。
  --fx-mesh-1 是首页背景那团最大的淡色，也换成主色，对得上「背景轻微渐变会同步变化」那句说明。
*/
const PRIMARY_CONTROL_VARS = [
  "--fx-primary-gradient",
  "--fx-primary-gradient-hover",
  "--fx-primary-fill",
  "--fx-primary-fill-hover",
  "--fx-primary-text",
  "--fx-primary-stroke",
  "--fx-primary-shadow",
  "--fx-mesh-1",
] as const;

type PresetColors = { primary: string; primaryForeground: string; ring: string; accent?: string };

function presetFollowsTokens(preset: unknown) {
  return (preset as { followsTokens?: boolean }).followsTokens === true;
}

export function applyPersonalizationTheme(value: unknown, root?: HTMLElement) {
  const target = root || (typeof document !== "undefined" ? document.documentElement : null);
  const id = normalizePersonalizationThemePresetId(value);
  if (!target) return id;
  const preset = getPersonalizationThemePreset(id);
  /*
    「面板默认」不写任何变量：让 design-tokens.css 里的值直接生效。写成
    `--fx-accent: var(--fx-accent)` 是自引用，浏览器会把整条链判成无效。
  */
  if (presetFollowsTokens(preset)) {
    clearThemeVariables(target);
    target.setAttribute("data-personalization-theme", id);
    return id;
  }
  const mode = target.classList.contains("dark") ? "dark" : "light";
  const values = mode === "dark" ? preset.dark : preset.light;
  for (const [key, cssVars] of Object.entries(THEME_VAR_MAP)) {
    const cssValue = values[key as keyof typeof values];
    for (const cssVar of cssVars) {
      target.style.setProperty(cssVar, cssValue);
    }
  }
  const colors = values as PresetColors;
  target.style.setProperty("--fx-accent", colors.accent || colors.primary);
  target.style.setProperty("--fx-accent-strong", colors.ring);
  target.style.setProperty("--fx-accent-soft", `color-mix(in srgb, ${colors.primary} 12%, transparent)`);
  target.style.setProperty("--fx-accent-fill", colors.primary);
  target.style.setProperty("--fx-accent-fill-foreground", colors.primaryForeground);
  const [from, to] = primaryGradientStops(colors.primary, mode);
  const darker = (color: string) => `color-mix(in oklab, ${color} 90%, black)`;
  target.style.setProperty("--fx-primary-gradient", linearGradient135([from, to]));
  target.style.setProperty("--fx-primary-gradient-hover", linearGradient135([darker(from), darker(to)]));
  target.style.setProperty("--fx-primary-fill", to);
  target.style.setProperty("--fx-primary-fill-hover", darker(to));
  target.style.setProperty("--fx-primary-text", colors.primaryForeground);
  target.style.setProperty("--fx-primary-stroke", `color-mix(in srgb, ${colors.primary} 45%, transparent)`);
  target.style.setProperty("--fx-primary-shadow", `0 8px 18px -10px color-mix(in srgb, ${to} 70%, transparent)`);
  target.style.setProperty("--fx-mesh-1", `color-mix(in srgb, ${colors.primary} ${mode === "dark" ? 18 : 22}%, transparent)`);
  target.setAttribute("data-personalization-theme", id);
  return id;
}

function clearThemeVariables(target: HTMLElement) {
  for (const cssVars of Object.values(THEME_VAR_MAP)) {
    for (const cssVar of cssVars) {
      target.style.removeProperty(cssVar);
    }
  }
  for (const cssVar of [...ACCENT_VARS, ...PRIMARY_CONTROL_VARS]) {
    target.style.removeProperty(cssVar);
  }
}

export function clearPersonalizationTheme(root?: HTMLElement) {
  const target = root || (typeof document !== "undefined" ? document.documentElement : null);
  if (!target) return;
  clearThemeVariables(target);
  target.removeAttribute("data-personalization-theme");
}
