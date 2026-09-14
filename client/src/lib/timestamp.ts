/**
 * 把各种形状的时间戳统一成毫秒，转发规则状态和链路可用性两处原来各存一份。
 */
export function timestampMillis(value: unknown) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) {
    // 小于 1e12 的当成秒 —— Agent 那边有的字段报的是秒。按毫秒解释会落在 1970 年，
    // 于是所有「几秒前」都变成「56 年前」，界面直接把在线的机器说成失联。
    return value > 0 && value < 1_000_000_000_000 ? value * 1000 : value;
  }
  const timestamp = new Date(String(value || "")).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}
