/**
 * 延迟图上的时间刻度「MM/DD HH:mm」，链路管理和转发组原来各存一份。
 * 用本地时区 —— 看图的人拿它跟自己的钟对。
 */
export function formatLatencyTimeLabel(value: string | Date) {
  const d = new Date(value);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const minute = String(d.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hour}:${minute}`;
}
