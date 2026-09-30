/**
 * 主机位置从哪来。
 *
 * - manual：用户在主机对话框里指定的，自动定位不会碰
 * - auto：按 IP 查出来的
 * - null：还没定到位（第一次查还没回来，或者三家服务都没答上来）
 *
 * 服务端给 hosts.list 的行加这个字段，界面据此画「手动」标签和「未定位」提示；
 * 地图以后也用它标注来源。
 */
export type HostGeoSource = "manual" | "auto" | null;

export function hostGeoSource(host: {
  geoManual?: boolean | null;
  geoCountryCode?: string | null;
  geoLatitudeMicro?: number | null;
  geoLongitudeMicro?: number | null;
} | null | undefined): HostGeoSource {
  if (!host) return null;
  const located = !!String(host.geoCountryCode || "").trim()
    || (host.geoLatitudeMicro != null && host.geoLongitudeMicro != null);
  if (host.geoManual) return "manual";
  return located ? "auto" : null;
}

export function isValidLatitude(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) && num >= -90 && num <= 90;
}

export function isValidLongitude(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) && num >= -180 && num <= 180;
}

/** 库里坐标存的是微度（整数），界面上用小数度 */
export function coordinateToMicro(value: number) {
  return Math.round(value * 1_000_000);
}

export function coordinateFromMicro(value: number | null | undefined) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Number(value) / 1_000_000;
}

export function isValidCountryCode(value: unknown) {
  return /^[A-Z]{2}$/.test(String(value || "").trim().toUpperCase());
}
