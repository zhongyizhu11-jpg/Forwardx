import * as React from "react"
import { cn } from "@/lib/utils"

type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  enterIndex?: number
  disableEnterAnimation?: boolean
}

function isDialogMotionLocked() {
  if (typeof document === "undefined") return false
  const lockUntil = Number(document.body.dataset.dialogMotionLockUntil || "0")
  return document.body.hasAttribute("data-dialog-motion-lock")
    || document.body.hasAttribute("data-dialog-scroll-lock")
    || document.body.hasAttribute("data-scroll-locked")
    || Date.now() < lockUntil
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(({ className, style, enterIndex, disableEnterAnimation, ...props }, ref) => {
  const [animateEnter, setAnimateEnter] = React.useState(() => !disableEnterAnimation && !isDialogMotionLocked())
  const enterStyle = enterIndex === undefined
    ? style
    : ({
        ...style,
        "--card-enter-delay": `${Math.min(Math.max(enterIndex, 0), 12) * 45}ms`,
      } as React.CSSProperties)

  React.useEffect(() => {
    if (!animateEnter) return
    const delay = Math.min(Math.max(enterIndex ?? 0, 0), 12) * 45
    const timer = window.setTimeout(() => setAnimateEnter(false), delay + 420)
    return () => window.clearTimeout(timer)
  }, [animateEnter, enterIndex])

  return (
    <div
      ref={ref}
      data-slot="card"
      className={cn(
        "glass-panel rounded-md transition-[border-color,box-shadow,transform] duration-300",
        animateEnter && "stagger-card",
        className,
      )}
      style={enterStyle}
      {...props}
    />
  )
})
Card.displayName = "Card"

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div data-slot="card-header" ref={ref} className={cn("flex flex-col space-y-1 p-3 sm:p-4", className)} {...props} />
))
CardHeader.displayName = "CardHeader"

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div data-slot="card-title" ref={ref} className={cn("text-[15px] font-semibold leading-snug tracking-tight sm:text-base", className)} {...props} />
))
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div data-slot="card-description" ref={ref} className={cn("text-[12.5px] text-muted-foreground sm:text-[13px]", className)} {...props} />
))
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div data-slot="card-content" ref={ref} className={cn("p-3 pt-0 sm:p-4 sm:pt-0", className)} {...props} />
))
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div data-slot="card-footer" ref={ref} className={cn("flex items-center p-3 pt-0 sm:p-4 sm:pt-0", className)} {...props} />
))
CardFooter.displayName = "CardFooter"

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }
