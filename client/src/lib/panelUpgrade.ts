import {
  applyGithubAccelerator,
  panelUpdateGithubAccelerator,
  type GithubAcceleratorSettings,
} from "@shared/githubAccelerator";

export const PANEL_UPGRADE_REFRESH_DELAY_SECONDS = 8;
export const PANEL_UPGRADE_REFRESH_DELAY_MS = PANEL_UPGRADE_REFRESH_DELAY_SECONDS * 1000;

const PANEL_RELEASES_URL = "https://github.com/zhongyizhu11-jpg/Forwardx/releases";

export function getPanelChangelogUrl(
  version?: string | null,
  releaseUrl?: string | null,
  githubAccelerator?: GithubAcceleratorSettings | null,
) {
  const accelerator = panelUpdateGithubAccelerator(githubAccelerator);
  if (releaseUrl) return applyGithubAccelerator(releaseUrl, accelerator);
  const normalizedVersion = String(version || "").trim();
  if (!normalizedVersion) return applyGithubAccelerator(PANEL_RELEASES_URL, accelerator);
  const tag = normalizedVersion.startsWith("v") ? normalizedVersion : `v${normalizedVersion}`;
  return applyGithubAccelerator(`${PANEL_RELEASES_URL}/tag/${encodeURIComponent(tag)}`, accelerator);
}

/*
  面板升级/回退的进度。

  原来这段逻辑有**两份**：侧边栏一份（DashboardLayout 的 getLayoutUpgradeProgress），
  设置页一份（Settings 的 getUpgradeProgress）。两份已经漂了 ——
  设置页那份多认三条日志特征（`transferring context`、`Packages:`、`node_modules`），
  文案也各写各的。

  后果是能同时看见的：Docker 构建必然打出 `transferring context` 这行，
  那一刻侧边栏说「52%　下载或拉取资产」，设置页说「74%　安装并重启」，
  而你在设置页升级时侧边栏就在旁边。又是那句老毛病：A 变了，B 没跟上。

  现在合成一份。日志特征取两份的并集（设置页那份是超集，多的三条都是真实
  存在的构建输出），文案取更准的那一版。

  关于百分比：这不是假进度 —— 四个步骤都是从真实日志特征判出来的里程碑，
  percent 只是把里程碑映射成条宽。所以手册「不要假进度」这条不冲突：
  它反对的是拿定时器凭空爬的那种。
*/

export type PanelUpgradeStep = { label: string; done: boolean; active: boolean };
export type PanelUpgradeProgress = { percent: number; label: string; steps: PanelUpgradeStep[] };
export type PanelUpgradeJob = { status?: string | null; mode?: string | null; logs?: unknown } | null | undefined;

export function getPanelUpgradeProgress(job: PanelUpgradeJob): PanelUpgradeProgress {
  const status = job?.status || "idle";
  const actionLabel = job?.mode === "rollback" ? "回退" : "升级";
  const logs = Array.isArray(job?.logs) ? job.logs.join("\n") : "";
  const matched = (patterns: RegExp[]) => patterns.some((pattern) => pattern.test(logs));
  const steps = [
    {
      label: `准备${actionLabel}`,
      done: status !== "idle" && matched([/开始升级/i, /开始回退/i, /Starting panel/i, /start/i]),
    },
    {
      label: "检查发布资产",
      done: matched([
        /Release assets/i,
        /not available yet/i,
        /still building/i,
        /发布资产/i,
        /构建完成/i,
        /Docker image/i,
        /panel bundle/i,
      ]),
    },
    {
      label: "下载或拉取资产",
      done: matched([
        /Downloading panel bundle/i,
        /Pulling image/i,
        /Downloaded newer image/i,
        /Image is up to date/i,
        /load metadata/i,
        /load build context/i,
        /transferring context/i,
        /pnpm install/i,
        /npm install/i,
        /Packages:/i,
        /node_modules/i,
        /downloaded/i,
        /Lockfile is up to date/i,
      ]),
    },
    {
      label: "安装并重启",
      done: matched([
        /Container .* (Creating|Created|Starting|Started)/i,
        /docker compose up/i,
        /systemctl restart/i,
        /已启动/i,
        /recreate/i,
      ]),
    },
  ];

  if (status === "success") {
    return {
      percent: 100,
      label: `${actionLabel}完成，正在等待面板恢复`,
      steps: steps.map((step) => ({ ...step, done: true, active: false })),
    };
  }
  if (status === "waiting_assets") {
    return {
      percent: 34,
      label: "等待 GitHub Actions 构建发布资产",
      steps: steps.map((step, index) => ({ ...step, done: index === 0, active: index === 1 })),
    };
  }

  const doneCount = steps.filter((step) => step.done).length;
  const activeIndex = Math.min(doneCount, steps.length - 1);
  const withActive = steps.map((step, index) => ({ ...step, active: index === activeIndex && !step.done }));

  if (status === "error") {
    return { percent: Math.max(10, doneCount * 22), label: `${actionLabel}异常`, steps: withActive };
  }
  if (status === "running") {
    return {
      percent: Math.min(92, Math.max(12, doneCount * 22 + 8)),
      label: steps[activeIndex]?.label || `正在${actionLabel}`,
      steps: withActive,
    };
  }
  return { percent: 0, label: `等待${actionLabel}`, steps: steps.map((step) => ({ ...step, active: false })) };
}
