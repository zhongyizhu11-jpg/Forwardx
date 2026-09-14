/**
 * 主机地理坐标与地图相关的小工具，全站唯一一份。
 *
 * 原来 hostGeoCoordinate 有四份（地图组件、链路管理、转发规则、主机管理），
 * escapeTooltipHtml 也是四份，聚类距离两份 —— 一字不差。同一台机器在四张图上
 * 该落在同一个点，坐标合法性的判断漂了就会出现「这台机器在隧道图上有、在主机
 * 图上没有」这种说不清的事。
 */

/**
 * 库里存的是微度整数（乘一百万），这里换回度。
 *
 * 超出经纬度范围的一律当成「没有坐标」而不是夹到边界上 —— 夹一下会把一台
 * 坐标写坏的机器稳稳地画在北极点，看起来像真的；返回 null 则是老实说不知道。
 */
export function hostGeoCoordinate(host: any) {
  if (host?.geoLatitudeMicro == null || host?.geoLongitudeMicro == null) return null;
  const lat = Number(host.geoLatitudeMicro) / 1_000_000;
  const lng = Number(host.geoLongitudeMicro) / 1_000_000;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/** 地图气泡是拼 HTML 字符串塞进去的，主机名里的尖括号必须转义。 */
export function escapeTooltipHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

/**
 * 经度是环形的：179° 和 -179° 只差 2°，不是 358°。
 *
 * 原样照搬原来那两份的实现（没有取模）—— 这一轮只做合并，不顺手改行为。
 * 入参都先过 hostGeoCoordinate 夹在 [-180, 180] 里，所以取模与否结果一样。
 */
export function longitudeDistanceDegrees(a: number, b: number) {
  const diff = Math.abs(a - b);
  return Math.min(diff, 360 - diff);
}

/**
 * 点到聚类中心的距离。
 *
 * 高纬度上一度经度对应的实际距离要短得多，所以按纬度余弦缩一下，
 * 否则北欧那一片机器会被判得比实际更散、聚不到一起。下限 0.35 是防止
 * 接近两极时缩成 0、把所有点判成同一个位置。
 */
export function hostMapClusterDistance(
  point: { lat: number; lng: number },
  cluster: { centerLat: number; centerLng: number },
) {
  const latDiff = point.lat - cluster.centerLat;
  const lngScale = Math.max(0.35, Math.cos((((point.lat + cluster.centerLat) / 2) * Math.PI) / 180));
  const lngDiff = longitudeDistanceDegrees(point.lng, cluster.centerLng) * lngScale;
  return Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);
}
