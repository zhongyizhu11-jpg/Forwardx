import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

/**
 * 换页时等待那一小段的占位。
 *
 * **延迟 250ms 才显示**：页面代码是按路由拆出去的小包，同机房/已缓存的情况下
 * 几十毫秒就到了 —— 那时候闪一下转圈比什么都不显示更糟，屏幕会抖。只有真的
 * 慢到人已经察觉了，才需要告诉他「在加载，不是卡死了」。
 */
export default function RouteFallback() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 250);
    return () => clearTimeout(timer);
  }, []);
  if (!visible) return null;
  return (
    <div className="flex min-h-[60svh] items-center justify-center" role="status" aria-live="polite">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      <span className="sr-only">正在加载页面</span>
    </div>
  );
}
