import { cn } from "@/lib/utils";

/**
 * 边框光束：一颗发光的点沿着卡片边框跑一圈。
 *
 * 手册把它定位成「强调正在进行」—— 下发中、检测中、生成中这类**真的有事在跑**
 * 的卡片。**不做常驻装饰**：一直亮着的光束等于没有光束，用户几秒钟就不看了。
 *
 * 实现上手册明确否掉了「conic-gradient 旋转 + mask 只留边框」那套旧方案
 * （理由是「那是渐变」），改用 `offset-path: rect(...)` 让一颗点沿矩形走。
 * 纯 CSS，零 JS，零渐变。
 *
 * 用法：父元素要 `relative`，圆角传得和父元素一致，否则点会走在边框外面。
 *
 *   <Card className="relative">
 *     {isRunning && <BorderBeam />}
 *     ...
 *   </Card>
 */
export function BorderBeam({
  radius = 12,
  seconds = 4,
  className,
}: {
  /** 和父元素的圆角保持一致（px）。卡片默认 12。 */
  radius?: number;
  /** 跑完一圈的秒数。手册给的是 4s。 */
  seconds?: number;
  className?: string;
}) {
  return (
    <span aria-hidden className={cn("fx-beam-layer", className)} style={{ borderRadius: `${radius}px` }}>
      <span
        className="fx-beam-dot"
        style={{
          offsetPath: `rect(0 100% 100% 0 round ${radius}px)`,
          ["--fx-beam-duration" as string]: `${seconds}s`,
        }}
      />
    </span>
  );
}
