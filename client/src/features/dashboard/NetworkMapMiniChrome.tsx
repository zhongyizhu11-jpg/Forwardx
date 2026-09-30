/**
 * 首页小图上漂浮的几样东西：右下角的 + / −、用户拖过之后左上角的「回到全览」、点主机 / 线时
 * 底部一闪而过的提示、右上角「N 台未定位」。
 *
 * 不引地图引擎，纯 DOM —— 单独拆出来是为了在 node 里能 renderToStaticMarkup 测（小图本体
 * 静态引用 MapLibre 和它的 CSS）。按钮全是 type=button、没有一个 href：小图上点哪儿都不跳整页，
 * 整页的入口只有卡片标题旁的「打开地图」。
 */
export function NetworkMapMiniChrome({ userMoved, tip, unlocated, onZoom, onReset }: {
  /** 用户拖过 / 缩过、还没回到全览：显示「回到全览」 */
  userMoved: boolean;
  /** 点了主机 / 线之后 2.5 秒内显示的一句话（null 不显示） */
  tip: string | null;
  /** 没有坐标、画不到图上的主机数 */
  unlocated: number;
  onZoom: (delta: number) => void;
  onReset: () => void;
}) {
  return (
    <>
      {userMoved ? (
        <button type="button" className="nm-mini-reset" onClick={onReset}>回到全览</button>
      ) : null}
      {/* 滚轮留给页面滚动，缩放靠这两个键；nm-reserved：名字和小窗都躲开它 */}
      <div className="nm-mini-zoom nm-reserved" role="group" aria-label="缩放">
        <button type="button" aria-label="放大" onClick={() => onZoom(1)}>+</button>
        <button type="button" aria-label="缩小" onClick={() => onZoom(-1)}>−</button>
      </div>
      {tip ? <div className="nm-mini-tip" role="status">{tip}</div> : null}
      {unlocated > 0 ? <span className="nm-mini-unlocated nm-reserved nm-num">{unlocated} 台未定位</span> : null}
    </>
  );
}
