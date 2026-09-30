/**
 * 升级用时的说法：「1 分 42 秒」「59 秒」。面板日志和界面上都用这一份，两边说的数才一样。
 */
export function formatUpgradeDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}
