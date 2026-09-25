import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

/*
  whitespace-nowrap：徽标是一个词，不折行。支付页订单表里「待支付」被列宽挤成「待支 / 付」两行，
  一个药丸形里竖着两行字，读起来像坏了。宁可让那一列宽一点（shadcn 上游后来也加了这一条）。
*/
const badgeVariants = cva("inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11.5px] font-medium leading-4 transition-colors focus:outline-none", {
  variants: {
    variant: {
      /*
        默认徽标：主色渐变的终点色 + 一层白色高光，和主按钮是同一道天蓝渐变。不直接铺
        --fx-primary-gradient：调用方常用 className 把它染成状态色（`bg-[var(--fx-healthy-soft)]` 之类），
        tailwind-merge 会把这里的底色换掉，但换不掉一张渐变图，图会把状态色盖住；高光是半透明的，盖不住。
      */
      default: "border-transparent bg-[var(--fx-primary-fill)] bg-[image:var(--fx-primary-sheen)] text-[var(--fx-primary-text)]",
      /*
        secondary 是**静态**徽标（TCP / UDP / 计数），不是悬停态。

        它原来用 bg-secondary 那块浅灰成形，而 bg-secondary 现在指向悬停色 ——
        静态元素挂悬停色，等于全站散着十几块「假的悬停」。而且面全白之后，
        那块浅灰正是「一屏都是灰」的主要来源。

        改成描边成形：形状由一条线给出，底色留白。
      */
      secondary: "border-[var(--fx-stroke-base)] bg-transparent text-[var(--fx-text-secondary)]",
      /* 软底、深字：一枚红底白字的实心徽标在一列灰字里像个警报灯，而它多半只是在说「已到期」 */
      destructive: "border-transparent bg-[var(--fx-down-soft)] text-[var(--fx-down-text)]",
      outline: "border-[var(--fx-stroke-base)] text-foreground",
    },
  },
  defaultVariants: { variant: "default" },
})

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div data-slot="badge" data-variant={variant ?? "default"} className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
