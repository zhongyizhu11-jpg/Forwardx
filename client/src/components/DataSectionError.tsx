import { AlertTriangle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { queryErrorHint, queryErrorMessage } from "@/lib/queryErrorMessage";
import { cn } from "@/lib/utils";

/**
 * 「这块没读到」。
 *
 * 和 DataSectionLoading 成对：加载中说加载中，失败就说失败，**不能退回空状态**。
 * 退回空状态等于面板在替后端撒谎 —— 「暂无支付流水」和「这次没取到支付流水」，
 * 对一个刚付过钱的人来说是两件天差地别的事。
 */
type DataSectionErrorProps = {
  /** 这块是什么数据，例如「账单流水」。 */
  label?: string;
  error?: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
  minHeight?: string;
};

export default function DataSectionError({
  label = "数据",
  error,
  onRetry,
  retrying = false,
  className,
  minHeight = "min-h-[180px]",
}: DataSectionErrorProps) {
  const hint = queryErrorHint(error);
  const detail = queryErrorMessage(error);
  return (
    <div
      role="status" aria-live="polite"
      className={cn(
        "flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-destructive/25 bg-destructive/[0.04] px-4 py-6 text-center",
        minHeight,
        className,
      )}
    >
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <AlertTriangle className="h-4 w-4 text-destructive" />
        <span>{label}加载失败</span>
      </div>
      <p className="max-w-md text-xs text-muted-foreground">
        {hint || "暂时无法获取数据，请重试。"}
      </p>
      {detail && (
        <p className="max-w-md break-all font-mono text-[11px] leading-relaxed text-muted-foreground">{detail}</p>
      )}
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-1" onClick={onRetry} disabled={retrying}>
          <RefreshCw className={cn("mr-2 h-3.5 w-3.5", retrying && "forwardx-icon-spin")} />
          重试
        </Button>
      )}
    </div>
  );
}

/** 表格里的同一件事：占满一行，别让「暂无」顶上去。 */
export function DataTableErrorRow({
  colSpan,
  label = "数据",
  error,
  onRetry,
  retrying = false,
}: DataSectionErrorProps & { colSpan: number }) {
  const hint = queryErrorHint(error);
  const detail = queryErrorMessage(error, 120);
  return (
    <tr>
      <td colSpan={colSpan} className="py-8 text-center align-middle">
        <div className="flex flex-col items-center gap-1.5">
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            {label}加载失败
          </span>
          <span className="text-xs text-muted-foreground">{hint || "暂时无法获取数据，请重试。"}</span>
          {detail && <span className="break-all font-mono text-[11px] text-muted-foreground">{detail}</span>}
          {onRetry && (
            <Button variant="outline" size="sm" className="mt-1" onClick={onRetry} disabled={retrying}>
              <RefreshCw className={cn("mr-2 h-3.5 w-3.5", retrying && "forwardx-icon-spin")} />
              重试
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}
