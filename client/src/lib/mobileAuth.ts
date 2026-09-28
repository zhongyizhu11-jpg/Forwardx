import { Preferences } from "@capacitor/preferences";

const PANEL_URL_KEY = "forwardx.mobile.panelUrl";
const USERNAME_KEY = "forwardx.mobile.username";
// 旧版本把明文密码存在这里（localStorage + Capacitor Preferences）。现在只记用户名和会话令牌，
// 这个 key 只用于启动/退出时清掉残留。
const LEGACY_PASSWORD_KEY = "forwardx.mobile.password";
const TOKEN_KEY = "forwardx.mobile.token";
const LOGGED_OUT_KEY = "forwardx.mobile.loggedOut";

const PERSISTED_KEYS = [PANEL_URL_KEY, USERNAME_KEY, TOKEN_KEY, LOGGED_OUT_KEY];

function isCapacitorRuntime() {
  if (typeof window === "undefined") return false;
  const capacitor = (window as any).Capacitor;
  return !!capacitor?.isNativePlatform?.();
}

function getNativePlatform() {
  if (!isCapacitorRuntime() || typeof window === "undefined") return "web";
  const platform = String((window as any).Capacitor?.getPlatform?.() || "").toLowerCase();
  if (platform === "android" || platform === "ios") return platform;
  return "native";
}

function getLocalValue(key: string) {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(key) || "";
}

function setLocalValue(key: string, value?: string | null) {
  if (typeof window === "undefined") return;
  if (value) window.localStorage.setItem(key, value);
  else window.localStorage.removeItem(key);
}

function persistNative(key: string, value?: string | null) {
  if (!isCapacitorRuntime()) return;
  const action = value ? Preferences.set({ key, value }) : Preferences.remove({ key });
  action.catch(() => undefined);
}

function setValue(key: string, value?: string | null) {
  setLocalValue(key, value);
  persistNative(key, value);
}

function removeLegacyPassword() {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(LEGACY_PASSWORD_KEY);
    } catch {
      // 存储不可用时没有可清的内容。
    }
  }
  if (isCapacitorRuntime()) {
    try {
      Preferences.remove({ key: LEGACY_PASSWORD_KEY }).catch(() => undefined);
    } catch {
      // 原生插件不可用时忽略。
    }
  }
}

function normalizePanelUrl(url: string) {
  return url.trim().replace(/\/+$/, "");
}

function isValidPanelUrl(url: string) {
  const normalized = normalizePanelUrl(url);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** 明文 http 面板：密码和会话令牌都会以明文传输。 */
function isInsecurePanelUrl(url: string) {
  const normalized = normalizePanelUrl(url);
  if (!isValidPanelUrl(normalized)) return false;
  return new URL(normalized).protocol === "http:";
}

export const mobileAuth = {
  get isNative() {
    return isCapacitorRuntime();
  },

  get platform() {
    return getNativePlatform();
  },

  normalizePanelUrl,

  isValidPanelUrl,

  isInsecurePanelUrl,

  async hydrateNative() {
    // 迁移：旧版本存过的明文密码，启动时一律删掉。
    removeLegacyPassword();
    if (!isCapacitorRuntime() || typeof window === "undefined") return;
    const syncFromNative = Promise.all(
      PERSISTED_KEYS.map(async (key) => {
        const { value } = await Preferences.get({ key });
        setLocalValue(key, value);
      }),
    );
    const hasLocalState = PERSISTED_KEYS.some((key) => !!getLocalValue(key));
    if (hasLocalState) {
      syncFromNative.catch(() => undefined);
      return;
    }
    await syncFromNative;
  },

  getPanelUrl() {
    return getLocalValue(PANEL_URL_KEY);
  },

  hasPanelUrl() {
    return isValidPanelUrl(getLocalValue(PANEL_URL_KEY));
  },

  setPanelUrl(url: string) {
    const normalized = normalizePanelUrl(url);
    setValue(PANEL_URL_KEY, normalized);
  },

  getUsername() {
    return getLocalValue(USERNAME_KEY);
  },

  /** 只记住用户名；密码不落盘，「记住登录」靠会话令牌。 */
  setUsername(username: string) {
    setValue(USERNAME_KEY, username.trim());
    setValue(LOGGED_OUT_KEY, "");
  },

  getToken() {
    return getLocalValue(TOKEN_KEY);
  },

  setToken(token?: string | null) {
    setValue(TOKEN_KEY, token || "");
    if (token) setValue(LOGGED_OUT_KEY, "");
  },

  clear() {
    setValue(TOKEN_KEY, "");
    removeLegacyPassword();
    setValue(LOGGED_OUT_KEY, "1");
  },

  wasLoggedOut() {
    return getLocalValue(LOGGED_OUT_KEY) === "1";
  },

  /**
   * 面板对外的地址，用来拼要交给别处的链接（订阅地址、安装命令、图片）。
   *
   * App 里页面跑在 capacitor://localhost（安卓是 https://localhost），直接拿
   * window.location.origin 拼出来的订阅地址，Shadowrocket 报「不支持的 URL」，
   * Loon 报「配置文件下载失败」。App 里要用登录时填的面板地址。
   */
  panelOrigin() {
    if (isCapacitorRuntime()) {
      const panelUrl = getLocalValue(PANEL_URL_KEY);
      if (isValidPanelUrl(panelUrl)) return normalizePanelUrl(panelUrl);
    }
    return typeof window === "undefined" ? "" : window.location.origin;
  },

  trpcUrl() {
    if (!isCapacitorRuntime()) return "/api/trpc";
    const panelUrl = mobileAuth.getPanelUrl();
    return isValidPanelUrl(panelUrl) ? `${normalizePanelUrl(panelUrl)}/api/trpc` : "/api/trpc";
  },
};
