import { lazy, Suspense } from "react";

import { NetworkMap } from "@/components/network/NetworkMap";
import { detectWebGL, locatedHostCount, shouldRenderRealMap } from "@/features/network/networkMapMini";
import { useNetworkMapModel, type NetworkMapModel } from "@/features/network/networkMapModel";

/**
 * 首页的「网络地图」：这个账号看得到的主机和它们之间的隧道，画在真地图上。
 *
 * 模型（buildNetworkMapModel / useNetworkMapModel）在 features/network/networkMapModel.ts，
 * 和 /map 整页共用一份 —— 这里红的，整页上也是红的。
 *
 * 卡片身子是 /map 那台画布的 mini 模式（NetworkMapMini，lazy 进来，首屏包不带地图引擎）：
 * 真实底图、每台主机一枚带国旗的圆盘、每条隧道一道大圆弧，正常的线上有从入口飞向出口的
 * 彗星、出口端有箭头 —— 一眼看出流量往哪儿走。图能拖能缩，点主机 / 线只闪一句提示，不跳
 * 整页 —— 整页的入口只有标题旁的「打开地图」。引擎没到、没有 WebGL、或者一台主机都没定位时，
 * 留着原来的 SVG 示意图（点主机 / 线去主机页 / 隧道页），不会比以前差。
 *
 * 一台主机都没有时整块不出现：那是「快速开始」的事，一张空地图什么也说不了。
 */
export { buildNetworkMapModel, useNetworkMapModel } from "@/features/network/networkMapModel";
export type { NetworkMapModel } from "@/features/network/networkMapModel";

const NetworkMapMini = lazy(() => import("./NetworkMapMini"));

export function NetworkMapSection({ enabled = true, onOpen }: { enabled?: boolean; onOpen: (href: string) => void }) {
  const model = useNetworkMapModel(enabled);
  if (!enabled || model.nodes.length === 0) return null;
  return <NetworkMapSectionView model={model} onOpen={onOpen} realMap={shouldRenderRealMap({ webgl: detectWebGL(), locatedHosts: locatedHostCount(model) })} />;
}

/** 卡片本身：拿到模型就能画，node 里 renderToStaticMarkup 也能测（realMap 为 false 时不碰引擎） */
export function NetworkMapSectionView({ model, onOpen, realMap }: { model: NetworkMapModel; onOpen: (href: string) => void; realMap: boolean }) {
  const legendItems = [
    { key: "healthy", label: "正常", count: model.legend.healthy, color: "var(--fx-accent)" },
    { key: "degraded", label: "降级", count: model.legend.degraded, color: "var(--fx-warn)" },
    { key: "down", label: "中断", count: model.legend.down, color: "var(--fx-down)" },
    { key: "standby", label: "停用", count: model.legend.standby, color: "var(--fx-standby)" },
  ].filter((item) => item.count > 0);
  const schematic = (
    <NetworkMap
      nodes={model.nodes}
      links={model.links}
      onSelectNode={() => onOpen("/hosts")}
      onSelectLink={() => onOpen("/tunnels")}
    />
  );

  return (
    <section
      aria-label="网络地图"
      className="fx-netmap-card fx-card-face flex min-w-0 flex-col overflow-hidden"
    >
      {/*
        图例放在标题那一行右边（「● 正常 2  ● 离线 1」），不再在图下面单占一行：
        「N 台主机 · N 条线路」页头已经说过，这里说的是颜色各代表什么、各几条。
      */}
      <div className="flex items-center justify-between gap-2 px-4 pt-3.5">
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="text-primary-type font-semibold text-foreground">网络地图</span>
          {/* 整页地图的唯一入口：可以点进主机和隧道看详情、换底图、看告警 */}
          <button
            type="button"
            onClick={() => onOpen("/map")}
            className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-[var(--fx-stroke-weak)] bg-[var(--fx-l3-control-fill)] px-2 py-0.5 text-meta font-medium text-[var(--fx-accent)] hover:bg-[var(--fx-hover)]"
          >
            打开地图
            <span aria-hidden="true">›</span>
          </button>
        </span>
        {legendItems.length > 0 ? (
          <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-0.5 text-meta text-[var(--fx-text-secondary)]">
            {legendItems.map((item) => (
              // 小圆点 + 名字 + 等宽的数：和图上状态点同一套颜色，数字用正文色，一眼扫得到「几条」
              <span key={item.key} className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: item.color }} />
                {item.label} <span className="font-medium tabular-nums text-foreground">{item.count}</span>
              </span>
            ))}
          </span>
        ) : (
          <span className="text-meta tabular-nums text-muted-foreground">{model.nodes.length} 台主机</span>
        )}
      </div>
      {realMap ? (
        <Suspense fallback={schematic}>
          <NetworkMapMini model={model} fallback={schematic} />
        </Suspense>
      ) : schematic}
      {model.hiddenLinkCount > 0 ? (
        <div className="px-4 pb-3 text-meta tabular-nums text-muted-foreground">{model.hiddenLinkCount} 条经过你看不到的主机，没有画出来</div>
      ) : legendItems.length === 0 ? (
        <div className="px-4 pb-3 text-meta text-muted-foreground">还没有线路。把两台主机连起来，这里就会出现第一条线。</div>
      ) : null}
    </section>
  );
}
