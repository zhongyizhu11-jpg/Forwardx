import * as React from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"
import { cn } from "@/lib/utils"

/*
  填充条：底色是主色渐变的终点色，上面压一层白色高光（--fx-primary-sheen），看起来就是全站那道天蓝渐变。
  不直接铺 --fx-primary-gradient，因为调用方会用 `[&>div]:bg-[var(--fx-down)]` 这类类名把条子染成状态色
  （主机 CPU / 内存 / 磁盘的绿黄红、超额的红）—— 一张不透明的渐变图会把状态色整个盖掉，高光不会。
*/
const Progress = React.forwardRef<React.ComponentRef<typeof ProgressPrimitive.Root>, React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>>(({ className, value, ...props }, ref) => (
  <ProgressPrimitive.Root ref={ref} className={cn("relative h-4 w-full overflow-hidden rounded-full bg-secondary", className)} {...props}>
    <ProgressPrimitive.Indicator className="h-full w-full flex-1 bg-[var(--fx-primary-fill)] bg-[image:var(--fx-primary-sheen)] transition-all" style={{ transform: `translateX(-${100 - (value || 0)}%)` }} />
  </ProgressPrimitive.Root>
))
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress }
