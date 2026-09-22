import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/useMobile";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type ConfirmTone = "default" | "destructive";

type ConfirmOptions = {
  title?: string;
  description: ReactNode;
  confirmText?: string;
  cancelText?: string;
  tone?: ConfirmTone;
};

type PendingConfirm = Required<Pick<ConfirmOptions, "title" | "confirmText" | "cancelText" | "tone">> & {
  description: ReactNode;
  resolve: (confirmed: boolean) => void;
};

const ConfirmDialogContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

const DEFAULT_CONFIRM_TITLE = "确认操作";

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);

  const close = useCallback((confirmed: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(confirmed);
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => {
    pendingRef.current?.resolve(false);
    return new Promise<boolean>((resolve) => {
      const next: PendingConfirm = {
        title: options.title || DEFAULT_CONFIRM_TITLE,
        description: options.description,
        confirmText: options.confirmText || "确认",
        cancelText: options.cancelText || "取消",
        tone: options.tone || "default",
        resolve,
      };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  const contextValue = useMemo(() => confirm, [confirm]);
  const isMobile = useIsMobile();

  return (
    <ConfirmDialogContext.Provider value={contextValue}>
      {children}
      <Dialog open={!!pending} onOpenChange={(open) => { if (!open) close(false); }}>
        {isMobile ? (
          /*
            手机上是 iOS 的 Action Sheet，不是缩小版的对话框。

            差别不只是长相。确认框的全部内容就是一个问题和两个答案，而桌面版为此
            摆了一个图标方块、一个左对齐标题、一段说明和两个右下角的小按钮 ——
            在 5 英寸的屏幕上，那两个小按钮正好落在拇指够不到的地方，而「删除」
            和「取消」挨着，误触的代价不对称。

            iOS 的答案：说明居中、小字；两个答案是两条撑满宽度的大行，破坏性的
            那条用红字；「取消」单独一块，和上面隔开一道缝 —— 那道缝就是防误触。
          */
          <DialogContent
            className="fx-action-sheet gap-0 border-0 bg-transparent p-0 shadow-none"
            /*
              不要把焦点自动放到第一个按钮上 —— 而第一个按钮正好是那个红色的
              「删除」。Radix 默认这么做，结果是弹出来之后随手一个回车/空格就
              执行了破坏性操作，而且屏幕上还套着一圈焦点框，看着像已经选中了。

              iOS 的操作表也不预选任何一项：两个答案都要手动点。
            */
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <div className="rounded-[var(--fx-radius-modal)] bg-[var(--fx-l1-surface)] text-center">
              <div className="flex flex-col gap-1 px-6 py-4">
                <DialogTitle className="text-secondary-type font-semibold text-foreground">
                  {pending?.title || DEFAULT_CONFIRM_TITLE}
                </DialogTitle>
                <DialogDescription asChild>
                  <div className="text-meta leading-relaxed text-muted-foreground">{pending?.description}</div>
                </DialogDescription>
              </div>
              <button
                type="button"
                onClick={() => close(true)}
                className="w-full border-t border-[var(--fx-stroke-weak)] px-6 py-3.5 text-primary-type font-semibold outline-none focus-visible:bg-[var(--fx-hover)]"
                style={pending?.tone === "destructive" ? { color: "var(--fx-down)" } : undefined}
              >
                {pending?.confirmText || "确认"}
              </button>
            </div>
            {/* 隔开的这道缝就是防误触：「取消」不该紧挨着「删除」 */}
            <button
              type="button"
              onClick={() => close(false)}
              className="mt-2 w-full rounded-[var(--fx-radius-modal)] bg-[var(--fx-l1-surface)] px-6 py-3.5 text-primary-type font-semibold text-foreground outline-none focus-visible:bg-[var(--fx-hover)]"
            >
              {pending?.cancelText || "取消"}
            </button>
          </DialogContent>
        ) : (
        <DialogContent className="max-w-md">
          <DialogHeader className="gap-3 pr-8">
            <div className={`flex h-10 w-10 items-center justify-center rounded-md ${
              pending?.tone === "destructive"
                ? "bg-destructive/10 text-destructive"
                : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
            }`}>
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="space-y-1.5 text-left">
              <DialogTitle>{pending?.title || DEFAULT_CONFIRM_TITLE}</DialogTitle>
              <DialogDescription asChild>
                <div className="text-sm leading-6 text-muted-foreground">{pending?.description}</div>
              </DialogDescription>
            </div>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => close(false)}>{pending?.cancelText || "取消"}</Button>
            <Button
              variant={pending?.tone === "destructive" ? "destructive" : "default"}
              onClick={() => close(true)}
            >
              {pending?.confirmText || "确认"}
            </Button>
          </DialogFooter>
        </DialogContent>
        )}
      </Dialog>
    </ConfirmDialogContext.Provider>
  );
}

export function useConfirmDialog() {
  const confirm = useContext(ConfirmDialogContext);
  if (!confirm) {
    throw new Error("useConfirmDialog must be used within ConfirmDialogProvider");
  }
  return confirm;
}
