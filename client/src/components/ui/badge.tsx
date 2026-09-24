import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

/*
  whitespace-nowrap：徽标是一个词，不折行。支付页订单表里「待支付」被列宽挤成「待支 / 付」两行，
  一个药丸形里竖着两行字，读起来像坏了。宁可让那一列宽一点（shadcn 上游后来也加了这一条）。
*/
const badgeVariants = cva("inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2", {
  variants: {
    variant: {
      default: "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
      /*
        secondary 是**静态**徽标（TCP / UDP / 计数），不是悬停态。

        它原来用 bg-secondary 那块浅灰成形，而 bg-secondary 现在指向悬停色 ——
        静态元素挂悬停色，等于全站散着十几块「假的悬停」。而且面全白之后，
        那块浅灰正是「一屏都是灰」的主要来源。

        改成描边成形：形状由一条线给出，底色留白。
      */
      secondary: "border-[var(--fx-stroke-base)] bg-transparent text-[var(--fx-text-secondary)]",
      destructive: "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
      outline: "text-foreground",
    },
  },
  defaultVariants: { variant: "default" },
})

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
