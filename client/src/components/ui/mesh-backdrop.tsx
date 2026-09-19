import { cn } from "@/lib/utils";

/**
 * 流动渐变背景：三团低透明度的灰，各自错开相位缓慢浮动。
 *
 * 手册的用法边界很清楚：**登录页、Hero、空状态卡片**。
 * **列表 / 表单 / 详情这类工具型页面不用** —— 那些页面用户是来干活的，
 * 背景动起来只会分散注意力。
 *
 * 关键是三团的**负 animation-delay**（-1.2s / -2.4s，写在 index.css 里）：
 * 同频就是「呼吸」，错开相位才是「流动」。
 *
 * 用法：父元素要 `relative overflow-hidden`，内容要 `relative z-10` 压在上面。
 */
export function MeshBackdrop({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("fx-mesh", className)}>
      <span className="fx-mesh-blob" />
      <span className="fx-mesh-blob" />
      <span className="fx-mesh-blob" />
    </div>
  );
}
