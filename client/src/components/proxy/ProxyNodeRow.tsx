import { useRef, useState, type ReactNode } from "react";
import { MoreHorizontal, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** ⋯ 菜单里的一项。传数据而不是 JSX：两段列表的菜单长得一样才叫协调。 */
export type ProxyNodeRowAction = {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  /** 危险操作排在分隔线之后，并染成警示色。 */
  destructive?: boolean;
};

/**
 * 节点行的统一骨架，「新建节点」与「落地节点」两段共用。
 *
 * 为什么第一行只放名字：这行原本是「名字 + 协议徽章 + 安全徽章 + 停用徽章」，
 * 徽章是 shrink-0 而名字是唯一能压缩的元素 —— 手机上一行就那么宽，动作按钮每多
 * 一个，被吃掉的全是名字，最后名字只剩一个字。所以把所有次要信息都压到第二行的
 * 一句 truncate 文字里，第一行留给名字，谁也抢不走。
 *
 * 为什么动作收进 ⋯：同样是宽度守恒。行内只留「用量」和开关两个常用的，其余进菜单；
 * 以后再加功能也只是菜单里多一项，不会再挤到名字。
 */
export function ProxyNodeRow({
  leading,
  name,
  meta,
  detail,
  inline,
  toggle,
  actions = [],
  muted = false,
}: {
  /** 状态点之类的前置标记。 */
  leading?: ReactNode;
  name: ReactNode;
  /** 第二行：协议、地址、端口、停用、分享人数……一句话说完，超长就截断。 */
  meta: ReactNode;
  /** 展开后的补充信息（如套餐用量），跟在第二行下面。 */
  detail?: ReactNode;
  /** 开关之前的一个小按钮，留给最常用的那一个。 */
  inline?: ReactNode;
  toggle?: ReactNode;
  actions?: ProxyNodeRowAction[];
  /** 停用的行整体压暗，不另外占一个徽章的位置。 */
  muted?: boolean;
}) {
  const normal = actions.filter((action) => !action.destructive);
  const destructive = actions.filter((action) => action.destructive);

  /**
   * 菜单项要做的事推迟到菜单真正关完再做。
   *
   * 这里的几项多半会弹一个对话框（确认删除、分享选人、编辑）。菜单和对话框都是
   * Radix 的浮层，在同一拍里一个关一个开，两边的焦点陷阱和 body 上的
   * pointer-events 会打架 —— 表现是对话框弹出来却点不动，或者整页失去响应。
   * 所以先记下来，等 onCloseAutoFocus（关闭动画结束后）再执行。
   */
  const [open, setOpen] = useState(false);
  const pending = useRef<null | (() => void)>(null);

  return (
    <div className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 ${muted ? "opacity-60" : ""}`}>
      {leading}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-tight">{name}</p>
        <p className="truncate text-[11px] leading-tight text-muted-foreground">{meta}</p>
        {detail}
      </div>
      {inline}
      {toggle}
      {actions.length > 0 ? (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" title="更多操作">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-40"
            onCloseAutoFocus={(event) => {
              // 焦点别弹回 ⋯ 按钮：接下来多半有个对话框要接管它。
              event.preventDefault();
              const run = pending.current;
              pending.current = null;
              run?.();
            }}
          >
            {normal.map((action) => (
              <DropdownMenuItem
                key={action.key}
                disabled={action.disabled}
                onSelect={() => { pending.current = action.onSelect; }}
              >
                <action.icon className="mr-2 h-3.5 w-3.5" />
                {action.label}
              </DropdownMenuItem>
            ))}
            {destructive.length > 0 && normal.length > 0 ? <DropdownMenuSeparator /> : null}
            {destructive.map((action) => (
              <DropdownMenuItem
                key={action.key}
                disabled={action.disabled}
                onSelect={() => { pending.current = action.onSelect; }}
                className="text-destructive focus:text-destructive"
              >
                <action.icon className="mr-2 h-3.5 w-3.5" />
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

/** 第二行那句话：把非空段落用 · 串起来，省掉一堆三元表达式。 */
export function proxyNodeMetaText(parts: Array<string | false | null | undefined>): string {
  return parts.filter((part): part is string => !!part && part.trim().length > 0).join(" · ");
}
