import { lazy, Suspense } from "react";

import { NetworkMap } from "@/components/network/NetworkMap";
import { detectWebGL, locatedHostCount, shouldRenderRealMap } from "@/features/network/networkMapMini";
import { LINE_KIND_SHORT, type LineKind } from "@/features/network/networkMapLines";
import { useNetworkMapModel, type NetworkMapModel } from "@/features/network/networkMapModel";

/**
 * 首页的「网络地图」：这个账号看得到的主机和它们之间的隧道，画在一张简单的真地图上。
 *
 * 这是面板里唯一的一张地图（整页 /map 已经去掉）：夜晚的地球做底图、每台主机在真实坐标上一圈
 * 发光的环、每条隧道一道大圆弧，颜色说状态（蓝主线路、橙虚线降级、红虚线中断），出口那头一个
 * 小箭头，正常的线上有往出口流的光点 —— 一眼看出谁连着谁、哪条断了。标题行右边是图例（主线路 /
 * 降级 / 中断，备用有才列），各几条。图能拖能缩，点主机 / 线 / 组只闪一句提示，哪儿都不跳。
 *
 * 地图引擎（NetworkMapMini，lazy 进来，首屏包不带）没到、没有 WebGL、或者一台主机都没定位时，
 * 留着原来的 SVG 示意图（点主机 / 线去主机页 / 隧道页）。
 *
 * 一台主机都没有时整块不出现：那是「快速开始」的事，一张空地图什么也说不了。
 */
export { buildNetworkMapModel, useNetworkMapModel } from "@/features/network/networkMapModel";
export type { NetworkMapModel } from "@/features/network/networkMapModel";

const NetworkMapMini = lazy(() => import("./NetworkMapMini"));

const dashed = (color: string) => ({ background: `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 6px)` });
/** 卡片标题行跟面板主题，用面板的语义色（图上的霓虹色是给深色地图校的）；备用线路的白灰在浅色卡上看不见，换成次要文字色 */
const LEGEND_SWATCH: Record<LineKind, React.CSSProperties> = {
  main: { background: "var(--fx-accent)" },
  backup: dashed("var(--fx-text-secondary)"),
  degraded: dashed("var(--fx-warn)"),
  down: dashed("var(--fx-down)"),
};

export function NetworkMapSection({ enabled = true, onOpen }: { enabled?: boolean; onOpen: (href: string) => void }) {
  const model = useNetworkMapModel(enabled);
  if (!enabled || model.nodes.length === 0) return null;
  return <NetworkMapSectionView model={model} onOpen={onOpen} realMap={shouldRenderRealMap({ webgl: detectWebGL(), locatedHosts: locatedHostCount(model) })} />;
}

/**
 * 图例列哪几类线：主线路、降级、中断三类一直列（0 条也写 0 —— 「没有中断」本身就是要看的信息），
 * 备用（停用 / 还没探出结论的隧道）只在有的时候列，不然它只是一个永远是 0 的格子。
 */
const LEGEND_ORDER: LineKind[] = ["main", "degraded", "down"];
export function legendItems(lines: Record<LineKind, number>): Array<{ key: LineKind; label: string; count: number }> {
  const kinds: LineKind[] = lines.backup > 0 ? [...LEGEND_ORDER, "backup"] : LEGEND_ORDER;
  return kinds.map((kind) => ({ key: kind, label: LINE_KIND_SHORT[kind], count: lines[kind] }));
}

/** 卡片本身：拿到模型就能画，node 里 renderToStaticMarkup 也能测（realMap 为 false 时不碰引擎） */
export function NetworkMapSectionView({ model, onOpen, realMap }: { model: NetworkMapModel; onOpen: (href: string) => void; realMap: boolean }) {
  const hasLines = model.lines.main + model.lines.backup + model.lines.degraded + model.lines.down > 0;
  const legend = hasLines ? legendItems(model.lines) : [];
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
      {/* 标题 + 图例一行：图例说的是颜色各代表什么、各几条（「N 台主机 · N 条线路」页头已经说过） */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-4 pt-3.5">
        <span className="shrink-0 whitespace-nowrap text-primary-type font-semibold text-foreground">网络地图</span>
        {legend.length > 0 ? (
          <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-0.5 text-meta text-[var(--fx-text-secondary)]">
            {legend.map((item) => (
              // 一小截线样 + 名字 + 等宽的数：和图上的线同一套画法（主线路实线、其余虚线），一眼扫得到「几条」
              <span key={item.key} className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="h-0.5 w-3.5 rounded-full" style={LEGEND_SWATCH[item.key]} />
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
      ) : !hasLines ? (
        <div className="px-4 pb-3 text-meta text-muted-foreground">还没有线路。把两台主机连起来，这里就会出现第一条线。</div>
      ) : null}
    </section>
  );
}
