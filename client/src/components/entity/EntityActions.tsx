import type { ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Entity 的操作区。**一级操作最多两个，其余全部收进 ···**
 *
 * 上一版每张卡底部常驻五个图标：波形、诊断、刷新、编辑、垃圾桶。问题不是
 * 图标丑，是用户必须记忆每个图标是什么意思 —— 而且十二条规则就是六十个图标，
 * 那一片图标本身成了页面上最吵的东西。
 *
 * 高频的留在外面并且**带文字**（图标 + 文字比纯图标快得多，尤其是「诊断」和
 * 「重新检测」这种看图标猜不出来的）；其余按固定顺序收进菜单。
 */

export type EntityAction = {
  key: string;
  label: string;
  /**
   * 读屏念的完整名字（「编辑隧道 HK -> JP」）。一列卡片上十个「编辑」，读屏用户分不清是哪一个；
   * 看得见的字仍然是 label，而且完整名字要以它开头（看得见的字得在念出来的名字里）。
   */
  ariaLabel?: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** 破坏性操作。永远排最后、永远红色、永远和上面隔一条线 */
  destructive?: boolean;
};

/**
 * 把一组操作分成「外面常驻的」和「菜单里的」，并保证破坏性操作排最后。
 *
 * 单独抽成纯函数不只是为了好测 —— Radix 的菜单内容是 portal 出去的，关着的
 * 时候根本不在 DOM 里，靠渲染结果验证不了顺序。而「删除永远排最后」正是这里
 * 最不能出错的一条：依赖每个调用方自己记得排，迟早有一处忘了，而那一处的
 * 后果是有人误删。
 */
export function partitionEntityActions(
  primary: readonly EntityAction[] = [],
  menu: readonly EntityAction[] = [],
): { shown: EntityAction[]; safe: EntityAction[]; destructive: EntityAction[] } {
  /*
    截断而不是报错：多传的那些不会消失，会被并进菜单。调用方一时传多了，
    用户也不会丢掉任何一个操作 —— 只是位置变了。
  */
  const shown = primary.slice(0, 2);
  const items = [...primary.slice(2), ...menu];
  return {
    shown,
    safe: items.filter((item) => !item.destructive),
    destructive: items.filter((item) => item.destructive),
  };
}

export function EntityActions({
  primary = [],
  menu = [],
  menuLabel = "更多操作",
  className,
}: {
  /** 常驻在外面的操作。**超过 2 个会被截断** —— 这是刻意的硬约束，不是 bug */
  primary?: EntityAction[];
  menu?: EntityAction[];
  menuLabel?: string;
  className?: string;
}) {
  const { shown, safe, destructive } = partitionEntityActions(primary, menu);

  return (
    <div className={cn("flex min-w-0 items-center gap-1", className)}>
      {shown.map((action) => (
        <Button
          key={action.key}
          type="button"
          variant="ghost"
          size="sm"
          disabled={action.disabled}
          onClick={action.onSelect}
          aria-label={action.ariaLabel}
          className="gap-1.5"
        >
          {action.icon}
          {action.label}
        </Button>
      ))}

      {safe.length > 0 || destructive.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" aria-label={menuLabel}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {safe.map((action) => (
              <DropdownMenuItem key={action.key} disabled={action.disabled} onSelect={action.onSelect} aria-label={action.ariaLabel}>
                {action.icon}
                {action.label}
              </DropdownMenuItem>
            ))}
            {safe.length > 0 && destructive.length > 0 ? <DropdownMenuSeparator /> : null}
            {destructive.map((action) => (
              <DropdownMenuItem
                key={action.key}
                disabled={action.disabled}
                onSelect={action.onSelect}
                aria-label={action.ariaLabel}
                /*
                  破坏性操作保留红色。那不是装饰 —— 它是唯一需要在点下去之前就
                  被看见的信息。
                */
                className="text-[var(--fx-health-critical)] focus:text-[var(--fx-health-critical)]"
              >
                {action.icon}
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
