import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"
import { cn } from "@/lib/utils"
import { settledToggleChecked } from "@/lib/optimisticToggle";

type SwitchProps = React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> & {
  instant?: boolean;
};

const Switch = React.forwardRef<React.ComponentRef<typeof SwitchPrimitives.Root>, SwitchProps>(({ className, instant = false, ...props }, ref) => (
  <SwitchPrimitives.Root data-slot="switch" className={cn("peer relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-border/70 bg-muted/80 shadow-inner focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 data-[state=checked]:border-primary/70 data-[state=checked]:bg-primary data-[state=unchecked]:border-border/70 data-[state=unchecked]:bg-muted/80 dark:data-[state=unchecked]:border-slate-500 dark:data-[state=unchecked]:bg-slate-700/90", instant ? "" : "transition-colors", className)} {...props} ref={ref}>
    <SwitchPrimitives.Thumb className={cn("pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 data-[state=checked]:translate-x-5 data-[state=checked]:bg-primary-foreground data-[state=unchecked]:translate-x-0 data-[state=unchecked]:bg-background dark:data-[state=unchecked]:bg-slate-100", instant ? "" : "transition-transform")} />
  </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

type OptimisticSwitchProps = Omit<SwitchProps, "checked" | "defaultChecked" | "onCheckedChange"> & {
  checked: boolean;
  onCheckedChangeAsync: (checked: boolean) => Promise<unknown>;
  onToggleSuccess?: (checked: boolean) => void;
  onToggleError?: (error: unknown, checked: boolean) => void;
};

const OptimisticSwitch = React.forwardRef<React.ComponentRef<typeof SwitchPrimitives.Root>, OptimisticSwitchProps>(
  ({ checked, disabled, onCheckedChangeAsync, onToggleSuccess, onToggleError, ...props }, ref) => {
    const [visualChecked, setVisualChecked] = React.useState(checked);
    const [isPending, setIsPending] = React.useState(false);
    const confirmedRef = React.useRef(checked);
    const desiredRef = React.useRef(checked);
    const runningRef = React.useRef(false);
    const mountedRef = React.useRef(true);
    const externalCheckedRef = React.useRef(checked);
    const callbacksRef = React.useRef({ onCheckedChangeAsync, onToggleSuccess, onToggleError });
    externalCheckedRef.current = checked;
    callbacksRef.current = { onCheckedChangeAsync, onToggleSuccess, onToggleError };

    React.useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
      };
    }, []);

    React.useEffect(() => {
      if (runningRef.current) return;
      confirmedRef.current = checked;
      desiredRef.current = checked;
      setVisualChecked(checked);
    }, [checked]);

    const runQueue = React.useCallback(async () => {
      if (runningRef.current) return;
      runningRef.current = true;
      if (mountedRef.current) setIsPending(true);
      try {
        while (desiredRef.current !== confirmedRef.current) {
          const nextChecked = desiredRef.current;
          try {
            await callbacksRef.current.onCheckedChangeAsync(nextChecked);
          } catch (error) {
            if (desiredRef.current === nextChecked) {
              desiredRef.current = confirmedRef.current;
              if (mountedRef.current) setVisualChecked(confirmedRef.current);
            }
            callbacksRef.current.onToggleError?.(error, nextChecked);
            continue;
          }

          confirmedRef.current = nextChecked;
          if (desiredRef.current === nextChecked) {
            callbacksRef.current.onToggleSuccess?.(nextChecked);
          }
        }
      } finally {
        runningRef.current = false;
        if (mountedRef.current) {
          setIsPending(false);
          /*
            队列跑完就以外部值为准，不管它和我们刚发出去的那个一不一样。

            原来这里只在两者相等时才回同步 —— 隐含假设是「请求什么，服务端就会变成
            什么」。而不相等恰恰是最该说出来的情形：给一个超额的用户开「转发」，
            服务端记下了意图但重算后生效值仍然是关，开关却一直亮着，刷新前谁也看
            不出来。外部值一时还没跟上的话，下面那个 effect 会在它到达时再同步一次
            （此刻 runningRef 已经清了，不会再被跳过）。
          */
          const settled = settledToggleChecked(externalCheckedRef.current, confirmedRef.current);
          confirmedRef.current = settled;
          desiredRef.current = settled;
          setVisualChecked(settled);
        }
      }
    }, []);

    return (
      <Switch
        {...props}
        ref={ref}
        checked={visualChecked}
        disabled={disabled}
        aria-busy={isPending || undefined}
        data-pending={isPending ? "true" : "false"}
        onCheckedChange={(nextChecked) => {
          desiredRef.current = nextChecked;
          setVisualChecked(nextChecked);
          void runQueue();
        }}
      />
    );
  },
)
OptimisticSwitch.displayName = "OptimisticSwitch"

export { OptimisticSwitch, Switch }
