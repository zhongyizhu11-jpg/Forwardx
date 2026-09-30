import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, MapPin, RefreshCw, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { GEO_CITIES, findGeoCityByKey, geoCityKey, geoCountryNameZh, matchGeoCity, searchGeoCities, type GeoCity } from "@shared/geoCities";
import { coordinateFromMicro, hostGeoSource, isValidCountryCode, isValidLatitude, isValidLongitude } from "@shared/hostGeoSource";
import { hostRegionText } from "./hostDisplay";

/**
 * 主机对话框里的「位置」行。
 *
 * 按 IP 自动定位对机房网段经常是错的（香港的机器落在深圳、美国的落错州），
 * 有时还干脆定不到。这里让用户三选一：
 *   - 按 IP 自动定位：清掉手动标记，立刻重查一次（hosts.relocate）
 *   - 选择城市：离线城市表里挑一个，中英文、国家、ISO 代码都能搜
 *   - 自定义经纬度：表里没有的地方，自己填
 *
 * 城市列表画在输入框正下方、在文档流里（不是浮层）：对话框内容区是 overflow
 * 滚动的，浮层会被裁掉一半。
 */

export type HostLocationMode = "auto" | "city" | "custom";

export type HostLocationFormValue = {
  mode: HostLocationMode;
  cityKey: string;
  countryCode: string;
  region: string;
  latitude: string;
  longitude: string;
};

export const emptyHostLocationValue: HostLocationFormValue = {
  mode: "auto",
  cityKey: "",
  countryCode: "",
  region: "",
  latitude: "",
  longitude: "",
};

function formatCoordinate(value: number | null) {
  return value == null ? "" : String(Math.round(value * 10000) / 10000);
}

/** 打开编辑对话框时，从主机现有的位置推出表单初值 */
export function hostLocationValueFromHost(host: any): HostLocationFormValue {
  if (!host?.geoManual) return emptyHostLocationValue;
  const city = matchGeoCity(host);
  if (city) return { ...emptyHostLocationValue, mode: "city", cityKey: geoCityKey(city) };
  return {
    mode: "custom",
    cityKey: "",
    countryCode: String(host.geoCountryCode || "").toUpperCase(),
    region: String(host.geoRegion || ""),
    latitude: formatCoordinate(coordinateFromMicro(host.geoLatitudeMicro)),
    longitude: formatCoordinate(coordinateFromMicro(host.geoLongitudeMicro)),
  };
}

export type HostLocationPayload = {
  geoManual: boolean;
  geoCountryCode?: string;
  geoRegion?: string | null;
  geoLatitude?: number;
  geoLongitude?: number;
};

/** 表单值 → 提交给 hosts.create / hosts.update 的字段；不合法时给出能直接 toast 的原因 */
export function hostLocationPayload(value: HostLocationFormValue): { ok: true; payload: HostLocationPayload } | { ok: false; error: string } {
  if (value.mode === "auto") return { ok: true, payload: { geoManual: false } };
  if (value.mode === "city") {
    const city = findGeoCityByKey(value.cityKey);
    if (!city) return { ok: false, error: "请选择一个城市，或改成按 IP 自动定位" };
    return { ok: true, payload: { geoManual: true, geoCountryCode: city.code, geoRegion: city.name, geoLatitude: city.lat, geoLongitude: city.lng } };
  }
  const countryCode = value.countryCode.trim().toUpperCase();
  if (!isValidCountryCode(countryCode)) return { ok: false, error: "国家/地区代码要是两位 ISO 代码，例如 HK、US" };
  const latitude = Number(value.latitude.trim());
  const longitude = Number(value.longitude.trim());
  if (!value.latitude.trim() || !isValidLatitude(latitude)) return { ok: false, error: "纬度要在 -90 到 90 之间" };
  if (!value.longitude.trim() || !isValidLongitude(longitude)) return { ok: false, error: "经度要在 -180 到 180 之间" };
  return {
    ok: true,
    payload: { geoManual: true, geoCountryCode: countryCode, geoRegion: value.region.trim() || null, geoLatitude: latitude, geoLongitude: longitude },
  };
}

function cityLabel(city: GeoCity) {
  return `${city.country} · ${city.name}`;
}

function CurrentLocationLine({ host }: { host: any }) {
  const source = hostGeoSource(host);
  if (source === null) {
    return (
      <span className="text-[var(--fx-warn-text)]">
        未定位 —— 定位服务还没答上来，后台会按间隔自动重试；也可以在下面直接指定。
      </span>
    );
  }
  const region = hostRegionText(host);
  const emoji = String(host?.geoEmoji || "").trim();
  const lat = coordinateFromMicro(host?.geoLatitudeMicro);
  const lng = coordinateFromMicro(host?.geoLongitudeMicro);
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {emoji ? <span aria-hidden>{emoji}</span> : null}
      <span className="truncate">{region || host?.geoCountryCode || "-"}</span>
      {lat != null && lng != null ? (
        <span className="font-mono text-[11px] text-muted-foreground">({formatCoordinate(lat)}, {formatCoordinate(lng)})</span>
      ) : null}
      <span className={cn("rounded px-1 py-px text-[10px] leading-4", source === "manual" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
        {source === "manual" ? "手动指定" : "按 IP 自动定位"}
      </span>
    </span>
  );
}

const MODE_ITEMS: Array<{ value: HostLocationMode; label: string }> = [
  { value: "auto", label: "按 IP 自动定位" },
  { value: "city", label: "选择城市" },
  { value: "custom", label: "自定义经纬度" },
];

export function HostLocationPicker({
  host,
  value,
  onChange,
  onRelocate,
  relocating = false,
  highlight = false,
}: {
  host: any;
  value: HostLocationFormValue;
  onChange: (next: HostLocationFormValue) => void;
  /** 「按 IP 自动定位」：清掉手动标记并立刻重查。新建主机时没有这台机器，不传。 */
  onRelocate?: () => void;
  relocating?: boolean;
  /** 从卡片上的「未定位 · 点此设置」进来：滚到这一行并闪一下 */
  highlight?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const selectedCity = useMemo(() => findGeoCityByKey(value.cityKey), [value.cityKey]);
  const results = useMemo(() => (searchOpen ? searchGeoCities(query, 40) : []), [query, searchOpen]);
  const isManualNow = !!host?.geoManual;

  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => rootRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }), 60);
    return () => clearTimeout(timer);
  }, [highlight]);

  const switchMode = (mode: HostLocationMode) => {
    if (mode === value.mode) return;
    if (mode === "auto") {
      onChange({ ...value, mode });
      // 现在是手动的话，选「自动」就是要回到按 IP：马上重查，不等保存。
      if (isManualNow && onRelocate) onRelocate();
      return;
    }
    if (mode === "custom" && selectedCity && !value.latitude && !value.longitude) {
      // 从城市切到自定义：把城市坐标带过去，方便在它基础上微调
      onChange({
        ...value,
        mode,
        countryCode: selectedCity.code,
        region: selectedCity.name,
        latitude: formatCoordinate(selectedCity.lat),
        longitude: formatCoordinate(selectedCity.lng),
      });
      return;
    }
    onChange({ ...value, mode });
  };

  return (
    <div
      ref={rootRef}
      className={cn("space-y-2 rounded-md transition-shadow", highlight ? "ring-2 ring-primary/40 ring-offset-2 ring-offset-background" : "")}
      data-testid="host-location-picker"
    >
      <div className="flex min-w-0 items-start gap-2 text-xs">
        <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 leading-5">
          <span className="text-muted-foreground">当前：</span>
          {host ? <CurrentLocationLine host={host} /> : <span className="text-muted-foreground">保存后按入口 IP 自动定位</span>}
        </div>
        {onRelocate && !isManualNow ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 gap-1 px-1.5 text-[11px]"
            disabled={relocating}
            onClick={onRelocate}
            title="丢掉缓存，按入口 IP 重新查一次"
          >
            {relocating ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            重新定位
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1 rounded-md bg-muted/50 p-1" role="radiogroup" aria-label="位置来源">
        {MODE_ITEMS.map((item) => (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={value.mode === item.value}
            onClick={() => switchMode(item.value)}
            className={cn(
              "h-7 rounded px-2.5 text-xs transition-colors",
              value.mode === item.value ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {value.mode === "city" ? (
        <div className="space-y-1.5">
          {selectedCity ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-2 py-0.5">
                <span>{cityLabel(selectedCity)}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{selectedCity.nameEn}</span>
                <button
                  type="button"
                  aria-label="清除所选城市"
                  className="ml-0.5 rounded p-0.5 text-muted-foreground hover:text-foreground"
                  onClick={() => onChange({ ...value, cityKey: "" })}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            </div>
          ) : null}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-8 pl-8"
              placeholder="搜索城市：深圳 / Tokyo / 美国 / HK"
              value={query}
              aria-label="搜索城市"
              onFocus={() => setSearchOpen(true)}
              onChange={(event) => {
                setQuery(event.target.value);
                setSearchOpen(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && results[0]) {
                  event.preventDefault();
                  onChange({ ...value, cityKey: geoCityKey(results[0]) });
                  setQuery("");
                  setSearchOpen(false);
                }
                if (event.key === "Escape") setSearchOpen(false);
              }}
            />
          </div>
          {searchOpen ? (
            <ul className="max-h-52 overflow-y-auto rounded-md border border-border/60 bg-card text-sm" role="listbox" aria-label="城市">
              {results.length === 0 ? (
                <li className="px-2.5 py-2 text-xs text-muted-foreground">没有匹配的城市，换个写法试试，或改用「自定义经纬度」</li>
              ) : results.map((city) => {
                const key = geoCityKey(city);
                const selected = key === value.cityKey;
                return (
                  <li key={key} role="option" aria-selected={selected}>
                    <button
                      type="button"
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left hover:bg-muted/60",
                        selected ? "bg-primary/10" : "",
                      )}
                      onClick={() => {
                        onChange({ ...value, cityKey: key });
                        setQuery("");
                        setSearchOpen(false);
                      }}
                    >
                      <span className="truncate">{cityLabel(city)}</span>
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{city.code} · {city.nameEn}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <p className="text-[11px] text-muted-foreground">共 {GEO_CITIES.length} 个城市；表里没有的地方用「自定义经纬度」。</p>
        </div>
      ) : null}

      {value.mode === "custom" ? (
        <div className="grid gap-2 sm:grid-cols-4">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">国家代码</Label>
            <Input
              className="h-8 font-mono uppercase"
              placeholder="HK"
              maxLength={2}
              value={value.countryCode}
              aria-label="国家代码"
              onChange={(event) => onChange({ ...value, countryCode: event.target.value.toUpperCase() })}
            />
            {value.countryCode.length === 2 ? (
              <p className="truncate text-[11px] text-muted-foreground">{geoCountryNameZh(value.countryCode)}</p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">显示名 <span className="opacity-70">可选</span></Label>
            <Input
              className="h-8"
              placeholder="例如：葵涌机房"
              value={value.region}
              aria-label="位置显示名"
              onChange={(event) => onChange({ ...value, region: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">纬度</Label>
            <Input
              className="h-8 font-mono"
              inputMode="decimal"
              placeholder="22.3193"
              value={value.latitude}
              aria-label="纬度"
              onChange={(event) => onChange({ ...value, latitude: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">经度</Label>
            <Input
              className="h-8 font-mono"
              inputMode="decimal"
              placeholder="114.1694"
              value={value.longitude}
              aria-label="经度"
              onChange={(event) => onChange({ ...value, longitude: event.target.value })}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
