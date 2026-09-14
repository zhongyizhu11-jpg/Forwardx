import { formatBytes } from "@shared/formatBytes";

/**
 * 「已用 / 总量」这一行，主机监控和主机管理原来各存一份。
 *
 * 没有总量时只显示已用 —— 硬凑一个 “/ 0 B” 出来，看的人会以为配额真的是 0。
 * 已用为 0 时整行留空，那一栏本来就没什么可说的。
 */
export function formatMetricSizeDetail(used: unknown, total: unknown) {
  const usedBytes = Number(used);
  const totalBytes = Number(total);
  if (!Number.isFinite(usedBytes) || usedBytes <= 0) return "";
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return formatBytes(usedBytes);
  return `${formatBytes(usedBytes)} / ${formatBytes(totalBytes)}`;
}
