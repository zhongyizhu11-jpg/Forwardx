export const BUILTIN_WALLPAPERS = [
  { id: "anime-1", name: "插画 1", url: "/wallpapers/anime-1.jpg" },
  { id: "anime-2", name: "二次元 2", url: "/wallpapers/anime-2.jpg" },
  { id: "anime-3", name: "二次元 3", url: "/wallpapers/anime-3.jpg" },
  { id: "anime-4", name: "二次元 4", url: "/wallpapers/anime-4.jpg" },
  { id: "illustration-1", name: "二次元 1", url: "/wallpapers/illustration-1.jpg" },
] as const;

export type BuiltinWallpaperId = typeof BUILTIN_WALLPAPERS[number]["id"];

/*
  配色预设换的是**强调色**（主按钮、开关、选中项、焦点环、路径、入站流量），
  状态色（健康 / 警告 / 故障）不跟着换 —— 它们说的是「它现在好不好」，换了预设也不该变。

  `ink` 是每个面板出厂就写进设置表的那个 id（dbSchema 的默认值），所以它就是「面板默认」：
  不往 <html> 上写任何变量，让 shared/design-tokens.css 里的紫色强调和浅深色两套值直接生效。
  想要以前那种黑白的选 `mono`。其余预设只给出 primary / ring 这几个值，
  强调色的三档由 applyPersonalizationTheme 从它们推出来（见 client/src/lib/personalizationTheme.ts）。
  `accent` 是可选的：给那些主色太浅、直接当小字过不了 4.5:1 的预设（樱粉、暖阳）。
*/
export const PERSONALIZATION_THEME_PRESETS = [
  {
    id: "ink",
    name: "面板默认",
    description: "跟随面板自带的配色：薰衣草紫强调、干净的状态色，浅深色各一套。",
    swatches: ["#6e56cf", "#e5dff5", "#0a0a0a"],
    followsTokens: true,
    light: {
      primary: "var(--fx-accent-fill)",
      primaryForeground: "var(--fx-accent-fill-foreground)",
      ring: "var(--fx-accent)",
      chart1: "var(--fx-chart-1)",
      chart2: "var(--fx-chart-6)",
      chart3: "var(--fx-chart-7)",
      chart4: "var(--fx-chart-8)",
      sidebarPrimary: "var(--fx-accent-fill)",
      sidebarPrimaryForeground: "var(--fx-accent-fill-foreground)",
      sidebarRing: "var(--fx-accent)",
    },
    dark: {
      primary: "var(--fx-accent-fill)",
      primaryForeground: "var(--fx-accent-fill-foreground)",
      ring: "var(--fx-accent)",
      chart1: "var(--fx-chart-1)",
      chart2: "var(--fx-chart-6)",
      chart3: "var(--fx-chart-7)",
      chart4: "var(--fx-chart-8)",
      sidebarPrimary: "var(--fx-accent-fill)",
      sidebarPrimaryForeground: "var(--fx-accent-fill-foreground)",
      sidebarRing: "var(--fx-accent)",
    },
  },
  {
    id: "mono",
    name: "墨色",
    description: "黑白灰：主按钮和选中项反黑，只有状态色带颜色。",
    swatches: ["#0a0a0a", "#e9e9e9", "#707070"],
    light: {
      primary: "var(--fx-text)",
      primaryForeground: "var(--fx-text-inverse)",
      ring: "var(--fx-text-secondary)",
      accent: "var(--fx-text)",
      chart1: "var(--fx-text-secondary)",
      chart2: "var(--fx-chart-6)",
      chart3: "var(--fx-chart-7)",
      chart4: "var(--fx-chart-8)",
      sidebarPrimary: "var(--fx-text)",
      sidebarPrimaryForeground: "var(--fx-text-inverse)",
      sidebarRing: "var(--fx-text-secondary)",
    },
    dark: {
      primary: "var(--fx-text)",
      primaryForeground: "var(--fx-text-inverse)",
      ring: "var(--fx-text-secondary)",
      accent: "var(--fx-text)",
      chart1: "var(--fx-text-secondary)",
      chart2: "var(--fx-chart-6)",
      chart3: "var(--fx-chart-7)",
      chart4: "var(--fx-chart-8)",
      sidebarPrimary: "var(--fx-text)",
      sidebarPrimaryForeground: "var(--fx-text-inverse)",
      sidebarRing: "var(--fx-text-secondary)",
    },
  },
  {
    id: "teal",
    name: "松石",
    description: "清爽青绿色，和浅色玻璃背景更协调。",
    swatches: ["#0f766e", "#99f6e4", "#134e4a"],
    light: {
      primary: "oklch(0.48 0.12 180)",
      primaryForeground: "oklch(0.98 0 0)",
      ring: "oklch(0.58 0.10 180)",
      chart1: "oklch(0.58 0.13 178)",
      chart2: "oklch(0.64 0.14 165)",
      chart3: "oklch(0.58 0.10 205)",
      chart4: "oklch(0.70 0.13 95)",
      sidebarPrimary: "oklch(0.48 0.12 180)",
      sidebarPrimaryForeground: "oklch(0.98 0 0)",
      sidebarRing: "oklch(0.58 0.10 180)",
    },
    dark: {
      primary: "oklch(0.72 0.14 180)",
      primaryForeground: "oklch(0.12 0.02 190)",
      ring: "oklch(0.72 0.11 180)",
      chart1: "oklch(0.72 0.14 180)",
      chart2: "oklch(0.76 0.14 165)",
      chart3: "oklch(0.72 0.10 205)",
      chart4: "oklch(0.80 0.13 95)",
      sidebarPrimary: "oklch(0.72 0.14 180)",
      sidebarPrimaryForeground: "oklch(0.12 0.02 190)",
      sidebarRing: "oklch(0.72 0.11 180)",
    },
  },
  {
    id: "forest",
    name: "森绿",
    description: "偏稳重的绿色，适合运维和资源管理场景。",
    swatches: ["#166534", "#86efac", "#14532d"],
    light: {
      primary: "oklch(0.43 0.12 145)",
      primaryForeground: "oklch(0.98 0 0)",
      ring: "oklch(0.54 0.10 145)",
      chart1: "oklch(0.56 0.13 145)",
      chart2: "oklch(0.60 0.15 135)",
      chart3: "oklch(0.50 0.10 170)",
      chart4: "oklch(0.70 0.13 95)",
      sidebarPrimary: "oklch(0.43 0.12 145)",
      sidebarPrimaryForeground: "oklch(0.98 0 0)",
      sidebarRing: "oklch(0.54 0.10 145)",
    },
    dark: {
      primary: "oklch(0.72 0.14 145)",
      primaryForeground: "oklch(0.12 0.02 150)",
      ring: "oklch(0.72 0.11 145)",
      chart1: "oklch(0.72 0.14 145)",
      chart2: "oklch(0.76 0.15 135)",
      chart3: "oklch(0.70 0.10 170)",
      chart4: "oklch(0.80 0.13 95)",
      sidebarPrimary: "oklch(0.72 0.14 145)",
      sidebarPrimaryForeground: "oklch(0.12 0.02 150)",
      sidebarRing: "oklch(0.72 0.11 145)",
    },
  },
  {
    id: "wisteria",
    name: "紫藤",
    description: "低饱和紫色，保留一点个性但不刺眼。",
    swatches: ["#6d28d9", "#ddd6fe", "#312e81"],
    light: {
      primary: "oklch(0.45 0.13 300)",
      primaryForeground: "oklch(0.98 0 0)",
      ring: "oklch(0.58 0.09 300)",
      chart1: "oklch(0.56 0.13 300)",
      chart2: "oklch(0.62 0.11 330)",
      chart3: "oklch(0.58 0.12 270)",
      chart4: "oklch(0.70 0.12 25)",
      sidebarPrimary: "oklch(0.45 0.13 300)",
      sidebarPrimaryForeground: "oklch(0.98 0 0)",
      sidebarRing: "oklch(0.58 0.09 300)",
    },
    dark: {
      primary: "oklch(0.74 0.13 300)",
      primaryForeground: "oklch(0.14 0.02 300)",
      ring: "oklch(0.74 0.10 300)",
      chart1: "oklch(0.74 0.13 300)",
      chart2: "oklch(0.78 0.11 330)",
      chart3: "oklch(0.74 0.12 270)",
      chart4: "oklch(0.80 0.12 25)",
      sidebarPrimary: "oklch(0.74 0.13 300)",
      sidebarPrimaryForeground: "oklch(0.14 0.02 300)",
      sidebarRing: "oklch(0.74 0.10 300)",
    },
  },
  {
    id: "ember",
    name: "暖阳",
    description: "温暖琥珀色，适合偏活泼的面板风格。",
    swatches: ["#92400e", "#fcd34d", "#451a03"],
    light: {
      primary: "oklch(0.50 0.12 70)",
      primaryForeground: "oklch(0.98 0 0)",
      ring: "oklch(0.62 0.10 70)",
      accent: "oklch(0.46 0.12 70)",
      chart1: "oklch(0.62 0.14 75)",
      chart2: "oklch(0.66 0.13 45)",
      chart3: "oklch(0.58 0.11 85)",
      chart4: "oklch(0.70 0.14 30)",
      sidebarPrimary: "oklch(0.50 0.12 70)",
      sidebarPrimaryForeground: "oklch(0.98 0 0)",
      sidebarRing: "oklch(0.62 0.10 70)",
    },
    dark: {
      primary: "oklch(0.78 0.14 75)",
      primaryForeground: "oklch(0.16 0.03 70)",
      ring: "oklch(0.78 0.11 75)",
      chart1: "oklch(0.78 0.14 75)",
      chart2: "oklch(0.80 0.13 45)",
      chart3: "oklch(0.76 0.11 85)",
      chart4: "oklch(0.82 0.14 30)",
      sidebarPrimary: "oklch(0.78 0.14 75)",
      sidebarPrimaryForeground: "oklch(0.16 0.03 70)",
      sidebarRing: "oklch(0.78 0.11 75)",
    },
  },
  {
    id: "sakura",
    name: "樱粉",
    description: "偏少女感的泡泡糖粉，适合柔和甜一点的面板风格。",
    swatches: ["#ff4fa3", "#ffd6ea", "#c4b5fd"],
    light: {
      primary: "oklch(0.70 0.18 350)",
      primaryForeground: "oklch(0.98 0 0)",
      ring: "oklch(0.78 0.12 350)",
      accent: "oklch(0.55 0.20 350)",
      chart1: "oklch(0.74 0.16 350)",
      chart2: "oklch(0.86 0.08 15)",
      chart3: "oklch(0.80 0.12 325)",
      chart4: "oklch(0.82 0.10 285)",
      sidebarPrimary: "oklch(0.70 0.18 350)",
      sidebarPrimaryForeground: "oklch(0.98 0 0)",
      sidebarRing: "oklch(0.78 0.12 350)",
    },
    dark: {
      primary: "oklch(0.86 0.14 350)",
      primaryForeground: "oklch(0.16 0.03 350)",
      ring: "oklch(0.88 0.11 350)",
      chart1: "oklch(0.86 0.14 350)",
      chart2: "oklch(0.90 0.08 15)",
      chart3: "oklch(0.88 0.11 325)",
      chart4: "oklch(0.86 0.10 285)",
      sidebarPrimary: "oklch(0.86 0.14 350)",
      sidebarPrimaryForeground: "oklch(0.16 0.03 350)",
      sidebarRing: "oklch(0.88 0.11 350)",
    },
  },
] as const;

export type PersonalizationThemePresetId = typeof PERSONALIZATION_THEME_PRESETS[number]["id"];

export function normalizePersonalizationThemePresetId(value: unknown): PersonalizationThemePresetId {
  const text = String(value || "").trim();
  return PERSONALIZATION_THEME_PRESETS.some((preset) => preset.id === text)
    ? text as PersonalizationThemePresetId
    : "ink";
}

export function getPersonalizationThemePreset(value: unknown) {
  const id = normalizePersonalizationThemePresetId(value);
  return PERSONALIZATION_THEME_PRESETS.find((preset) => preset.id === id) || PERSONALIZATION_THEME_PRESETS[0];
}

export type PersonalizationBackgroundSource = "none" | "builtin" | "upload" | "url";
export type PersonalizationBackgroundUrlType = "image" | "video";

export type PersonalizationBackgroundImage = {
  id: string;
  name: string;
  dataUrl: string;
  size?: number;
  createdAt?: number;
};

export type PersonalizationBackgroundConfig = {
  source: PersonalizationBackgroundSource;
  opacity: number;
  blur: number;
  selectedId: string | null;
  url: string;
  urlType: PersonalizationBackgroundUrlType;
  images: PersonalizationBackgroundImage[];
};

export const DEFAULT_PERSONALIZATION_BACKGROUND: PersonalizationBackgroundConfig = {
  source: "none",
  opacity: 0.22,
  blur: 0,
  selectedId: null,
  url: "",
  urlType: "image",
  images: [],
};

export function isBuiltinWallpaperId(value: unknown): value is BuiltinWallpaperId {
  return BUILTIN_WALLPAPERS.some((item) => item.id === value);
}

export function builtinWallpaperById(value: unknown) {
  return BUILTIN_WALLPAPERS.find((item) => item.id === value) || null;
}

export function clampBackgroundOpacity(value: unknown) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_PERSONALIZATION_BACKGROUND.opacity;
  return Math.min(1, Math.max(0, num));
}

export function clampBackgroundBlur(value: unknown) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_PERSONALIZATION_BACKGROUND.blur;
  return Math.min(32, Math.max(0, num));
}
