/*
  版本比较走 shared/version.ts 那一份。这里原来自己写了一份，差别在后缀：
  它按 "." 切，`2.3.364-beta.1` 的第三段成了 `"364-beta"`，`Number()` 得 NaN 归 0，
  于是这个版本被当成 `2.3.0` —— 比 `2.3.100` 还旧。共用那份按 `[.-]` 切，得 364。
  今天 ANDROID_APP_VERSION 一直是干净的 x.y.z，所以这是个潜伏问题；
  哪天发一个 rc 版就会发作。
*/
import { compareVersions } from "@shared/version";
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { LocalNotifications } from "@capacitor/local-notifications";
import { mobileAuth } from "@/lib/mobileAuth";

const SETTINGS_KEY = "forwardx.mobile.notificationSettings";
const RELEASES_URL = "https://github.com/zhongyizhu11-jpg/Forwardx/releases";
const LATEST_RELEASE_URL = "https://github.com/zhongyizhu11-jpg/Forwardx/releases/latest";
const RELEASES_API_URL = "https://api.github.com/repos/zhongyizhu11-jpg/Forwardx/releases?per_page=20";

export type MobileNotificationSettings = {
  trafficEnabled: boolean;
  trafficThresholdPercent: number;
  expiryEnabled: boolean;
  expiryDaysBefore: number;
  reminderTime: string;
  upgradeAutoCheck: boolean;
};

export type MobileReminderSnapshot = {
  trafficLimit?: number | null;
  trafficUsed?: number | null;
  expiresAt?: string | Date | null;
};

export type MobileAppUpdateResult = {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  platform: "android";
  packageLabel: "APK";
  hasPackage: boolean;
  hasApk: boolean;
};

export const defaultMobileNotificationSettings: MobileNotificationSettings = {
  trafficEnabled: false,
  trafficThresholdPercent: 20,
  expiryEnabled: false,
  expiryDaysBefore: 3,
  reminderTime: "09:00",
  upgradeAutoCheck: false,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeReminderTime(value: unknown) {
  if (typeof value !== "string") return defaultMobileNotificationSettings.reminderTime;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return defaultMobileNotificationSettings.reminderTime;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return defaultMobileNotificationSettings.reminderTime;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function normalizeMobileNotificationSettings(
  input: Partial<MobileNotificationSettings> | null | undefined,
): MobileNotificationSettings {
  return {
    trafficEnabled: !!input?.trafficEnabled,
    trafficThresholdPercent: clamp(Number(input?.trafficThresholdPercent || 20), 1, 99),
    expiryEnabled: !!input?.expiryEnabled,
    expiryDaysBefore: clamp(Number(input?.expiryDaysBefore || 3), 1, 30),
    reminderTime: normalizeReminderTime(input?.reminderTime),
    upgradeAutoCheck: !!input?.upgradeAutoCheck,
  };
}

export function getMobileNotificationSettings(): MobileNotificationSettings {
  if (typeof window === "undefined") return defaultMobileNotificationSettings;
  try {
    return normalizeMobileNotificationSettings(JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "null"));
  } catch {
    return defaultMobileNotificationSettings;
  }
}

export function saveMobileNotificationSettings(settings: MobileNotificationSettings) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalizeMobileNotificationSettings(settings)));
}

async function ensureNotificationPermission() {
  const current = await LocalNotifications.checkPermissions();
  if (current.display === "granted") return true;
  const requested = await LocalNotifications.requestPermissions();
  return requested.display === "granted";
}

function dateAtReminderTime(base: number | Date, time: string) {
  const [hour, minute] = normalizeReminderTime(time).split(":").map(Number);
  const date = new Date(base);
  date.setHours(hour, minute, 0, 0);
  return date;
}

function nextReminderDate(time: string) {
  const date = dateAtReminderTime(Date.now(), time);
  if (date.getTime() <= Date.now() + 30_000) date.setDate(date.getDate() + 1);
  return date;
}

export async function scheduleMobileReminders(settings: MobileNotificationSettings, snapshot: MobileReminderSnapshot) {
  if (!mobileAuth.isNative) return;

  await LocalNotifications.cancel({ notifications: [{ id: 40101 }, { id: 40102 }] }).catch(() => undefined);
  if (!settings.trafficEnabled && !settings.expiryEnabled) return;
  if (!(await ensureNotificationPermission())) return;

  const normalized = normalizeMobileNotificationSettings(settings);
  const notifications: Parameters<typeof LocalNotifications.schedule>[0]["notifications"] = [];
  const trafficLimit = Number(snapshot.trafficLimit || 0);
  const trafficUsed = Number(snapshot.trafficUsed || 0);

  if (normalized.trafficEnabled && trafficLimit > 0) {
    const remainingPercent = Math.max(0, Math.round(((trafficLimit - trafficUsed) / trafficLimit) * 100));
    if (remainingPercent <= normalized.trafficThresholdPercent) {
      notifications.push({
        id: 40101,
        title: "ForwardX 流量提醒",
        body: `套餐流量剩余约 ${remainingPercent}%，请及时关注。`,
        schedule: { at: nextReminderDate(normalized.reminderTime) },
      });
    }
  }

  if (normalized.expiryEnabled && snapshot.expiresAt) {
    const expiresAt = new Date(snapshot.expiresAt).getTime();
    if (Number.isFinite(expiresAt)) {
      const targetDate = dateAtReminderTime(expiresAt - normalized.expiryDaysBefore * 86_400_000, normalized.reminderTime);
      const notifyAt = Math.max(Date.now() + 60_000, targetDate.getTime());
      if (notifyAt <= expiresAt) {
        notifications.push({
          id: 40102,
          title: "ForwardX 套餐到期提醒",
          body: `套餐将在 ${normalized.expiryDaysBefore} 天内到期，请及时续费或联系管理员。`,
          schedule: { at: new Date(notifyAt) },
        });
      }
    }
  }

  if (notifications.length) await LocalNotifications.schedule({ notifications });
}

function extractMobilePackageVersion(assetName: string) {
  const pattern = /^forwardx-android-v?(\d+\.\d+\.\d+)(?:-[\w.-]+)?\.apk$/i;
  const match = assetName.match(pattern);
  return match?.[1] || null;
}

export async function openMobileReleasePage(url = RELEASES_URL) {
  const targetUrl = url || RELEASES_URL;
  if (mobileAuth.isNative) await Browser.open({ url: targetUrl });
  else window.open(targetUrl, "_blank", "noopener,noreferrer");
}

export async function checkMobileAppUpdate(options: { silent?: boolean } = {}): Promise<MobileAppUpdateResult | null> {
  if (!mobileAuth.isNative) return null;
  if (mobileAuth.platform !== "android") return null;

  try {
    const [appInfo, response] = await Promise.all([
      App.getInfo(),
      fetch(RELEASES_API_URL, {
        headers: { Accept: "application/vnd.github+json" },
      }),
    ]);
    if (!response.ok) throw new Error(`GitHub ${response.status}`);

    const releases = await response.json();
    const current = String(appInfo.version || "").replace(/^v/i, "");
    const packageCandidates = (Array.isArray(releases) ? releases : [])
      .flatMap((release: any) => (Array.isArray(release?.assets) ? release.assets : []).map((asset: any) => {
        const name = String(asset?.name || "");
        const version = extractMobilePackageVersion(name);
        if (!version) return null;
        return {
          version,
          releaseUrl: release?.html_url || `${RELEASES_URL}/tag/${release?.tag_name || ""}`,
        };
      }))
      .filter(Boolean)
      .sort((a: any, b: any) => compareVersions(b.version, a.version));
    const latestPackage = packageCandidates[0] as { version: string; releaseUrl: string } | undefined;
    const latest = latestPackage?.version || current;
    const hasPackage = packageCandidates.length > 0;
    const hasUpdate = hasPackage && !!latest && !!current && compareVersions(latest, current) > 0;
    const releaseUrl = latestPackage?.releaseUrl || LATEST_RELEASE_URL;

    return {
      hasUpdate,
      currentVersion: current,
      latestVersion: latest,
      releaseUrl,
      platform: "android",
      packageLabel: "APK",
      hasPackage,
      hasApk: hasPackage,
    };
  } catch (error) {
    if (!options.silent) throw error;
    return null;
  }
}
