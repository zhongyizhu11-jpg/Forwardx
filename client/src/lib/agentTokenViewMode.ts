export type AgentTokenViewMode = "card" | "table";

const STORAGE_KEY = "forwardx.agentTokens.viewMode";

/**
 * Token 列表用卡片还是表格，记在本地。
 *
 * 主机管理页和 Token 管理组件原来各存一份读写实现**和同一个 storage key** ——
 * 两份读写同一把锁，改哪一份都只改了一半。
 */
export function getStoredAgentTokenViewMode(): AgentTokenViewMode {
  if (typeof window === "undefined") return "card";
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "table" ? "table" : "card";
  } catch {
    return "card";
  }
}

export function storeAgentTokenViewMode(viewMode: AgentTokenViewMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, viewMode);
  } catch {
    // 浏览器禁了本地存储时照常工作，只是下次进来回到默认视图。
  }
}
