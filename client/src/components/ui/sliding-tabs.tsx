import { type ComponentType, type CSSProperties, type ReactNode } from "react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export type SlidingTabItem<T extends string = string> = {
  value: T;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  badge?: ReactNode;
  disabled?: boolean;
};

const slidingTabTriggerClass = "group relative z-10 h-9 min-w-0 justify-center gap-1.5 rounded-md border-0 bg-transparent px-3 text-sm font-medium text-muted-foreground shadow-none ring-0 transition-colors duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-transparent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/35 data-[state=active]:border-transparent data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:ring-0 [&>svg]:shrink-0";

type SlidingTabsListProps<T extends string> = {
  items: readonly SlidingTabItem<T>[];
  activeValue: T;
  ariaLabel?: string;
  className?: string;
  listClassName?: string;
  triggerClassName?: string;
  iconClassName?: string;
  badgeClassName?: string;
  minItemWidthRem?: number;
};

export function SlidingTabsList<T extends string>({
  items,
  activeValue,
  ariaLabel,
  className,
  listClassName,
  triggerClassName,
  iconClassName,
  badgeClassName,
  minItemWidthRem = 7.25,
}: SlidingTabsListProps<T>) {
  // Wrap into rows on narrow screens: no hidden tabs or horizontal swiping.
  // Keep the existing prop/export names so callers need no migration.
  const listStyle: CSSProperties = {
    gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${minItemWidthRem}rem), 1fr))`,
  };

  return (
    <div className={cn("w-full min-w-0", className)}>
      <TabsList
        aria-label={ariaLabel}
        className={cn(
          "grid h-auto w-full gap-2 rounded-xl border border-border bg-background p-1 text-muted-foreground",
          listClassName,
        )}
        style={listStyle}
      >
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <TabsTrigger
              key={item.value}
              value={item.value}
              disabled={item.disabled}
              data-active={item.value === activeValue ? "true" : undefined}
              className={cn(slidingTabTriggerClass, triggerClassName)}
            >
              {Icon && <Icon className={cn("h-3.5 w-3.5 text-current", iconClassName)} />}
              {item.label}
              {item.badge !== undefined && item.badge !== null && (
                <span className={cn(
                  "ml-0.5 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-semibold leading-none text-muted-foreground transition-colors group-data-[state=active]:bg-muted group-data-[state=active]:text-foreground",
                  badgeClassName,
                )}>
                  {item.badge}
                </span>
              )}
            </TabsTrigger>
          );
        })}
      </TabsList>
    </div>
  );
}
