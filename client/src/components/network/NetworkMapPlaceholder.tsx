/**
 * 网络地图还没到时占住的位置：和真地图同样大小、同样深色的一块（.fx-netmap.nm-mini 的尺寸、圆角、描边），
 * 地图引擎到了直接盖上去，页面不跳、也不先闪一张别的图。
 *
 * 只用 Tailwind 的类、不引 networkMap.css：那份样式跟着地图 lazy 进来，占位要在它之前就能画。
 * 颜色是图那块固定的深色（--nm-water 和描边），和 .nm-surface 一样不跟面板主题；尺寸、颜色改了要和
 * networkMap.css 里的 .fx-netmap.nm-mini 一起改。
 */
export function NetworkMapBoxPlaceholder() {
  return (
    <div
      aria-hidden="true"
      className="relative mx-[12px] mb-[12px] mt-[10px] h-[300px] shrink-0 overflow-hidden rounded-[14px] border border-[rgba(34,211,238,0.22)] bg-[#000213] shadow-[inset_0_0_0_1px_rgba(2,6,14,0.6)] min-[900px]:h-[380px]"
    />
  );
}

/** 整张卡片的占位：标题行 + 地图那块；主机列表还没回来、但上次这里有图时先占着 */
export function NetworkMapCardPlaceholder() {
  return (
    <section aria-label="网络地图" aria-busy="true" className="fx-netmap-card fx-card-face flex min-w-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-4 pt-3.5">
        <span className="shrink-0 whitespace-nowrap text-primary-type font-semibold text-foreground">网络地图</span>
      </div>
      <NetworkMapBoxPlaceholder />
    </section>
  );
}
