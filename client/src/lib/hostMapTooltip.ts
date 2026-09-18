import { escapeTooltipHtml } from "@/lib/hostGeo";

/**
 * 地图上悬停一台机器弹出的那张卡，平面地图和 3D 地球共用一份。
 *
 * 原来两页各抄了一份（889 token，相似度 0.95），差别只有两处：坐标点的颜色一边
 * 是 deck.gl 的 `[r,g,b,a]` 数组、一边是 CSS 串；再就是宽度 330/320、底色透明度
 * .94/.92 —— 后两处不是设计意图，是两份在不同时间各自被改过的痕迹。
 *
 * 合并后统一按平面地图那份（330px / .94），地球上的卡片因此宽 10px、底色深 2%。
 * 颜色交给调用方先转成 CSS 串再进来，这样这里不必认识 deck.gl 的表示法。
 */
export type HostMapTooltipPoint = {
  name: string;
  addressText: string;
  regionText: string;
  osInfo: string;
  agentVersion: string;
  statusText: string;
  /** 已经是 CSS 颜色串 —— deck.gl 那边先过 deckColorToCss。 */
  color: string;
  glowColor: string;
  countryCode: string;
  flagUrl: string;
};

export function renderHostMapTooltip(point: HostMapTooltipPoint) {
  const rows = [
    { label: "地址", value: point.addressText },
    { label: "地区", value: point.regionText || "地区获取中" },
    { label: "系统", value: point.osInfo || "系统信息未上报" },
    { label: "Agent", value: point.agentVersion ? `v${point.agentVersion}` : "未上报" },
  ];
  /*
    国旗加载不出来时切换到国家代码：地图上有一批机器在小国家/地区，旗帜 CDN 被挡
    是常事，掉了图标还能看出是哪儿。
  */
  const regionValue = point.flagUrl
    ? `<span style="display:inline-flex;min-width:0;align-items:center;gap:7px;"><img src="${escapeTooltipHtml(point.flagUrl)}" alt="${escapeTooltipHtml(point.countryCode)}" referrerpolicy="no-referrer" style="width:20px;height:15px;flex:0 0 auto;border-radius:2px;object-fit:cover;" onerror="this.style.display='none';this.nextElementSibling.style.display='inline';" /><span style="display:none;flex:0 0 auto;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono',monospace;font-size:11px;color:#cbd5e1;">${escapeTooltipHtml(point.countryCode)}</span><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;">${escapeTooltipHtml(point.regionText || "地区获取中")}</span></span>`
    : escapeTooltipHtml(point.regionText || "地区获取中");
  return `
    <div style="min-width:260px;max-width:330px;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(8,13,24,.94);box-shadow:0 18px 44px rgba(0,0,0,.4);backdrop-filter:blur(10px);color:#f8fafc;padding:12px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;">
        <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:700;">${escapeTooltipHtml(point.name || "-")}</div>
        <div style="display:flex;align-items:center;gap:6px;color:#cbd5e1;font-size:12px;">
          <span style="width:8px;height:8px;border-radius:999px;background:${point.color};box-shadow:0 0 14px ${point.glowColor};"></span>
          ${escapeTooltipHtml(point.statusText)}
        </div>
      </div>
      ${rows.map((row) => `
        <div style="display:grid;grid-template-columns:42px minmax(0,1fr);gap:8px;align-items:start;margin-top:6px;font-size:12px;line-height:1.45;">
          <span style="color:#94a3b8;">${escapeTooltipHtml(row.label)}</span>
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;color:#e2e8f0;${row.label === "地址" || row.label === "Agent" ? "font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono',monospace;" : ""}">${row.label === "地区" ? regionValue : escapeTooltipHtml(row.value)}</span>
        </div>
      `).join("")}
    </div>
  `;
}
