import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type DataSectionLoadingProps = {
  label?: string;
  className?: string;
  minHeight?: string;
};

export default function DataSectionLoading({
  label = "数据加载中",
  className,
  minHeight = "min-h-[180px]",
}: DataSectionLoadingProps) {
  /*
    一块白底、不描边，和卡片同一种 surface：坐在灰页面上时占住内容将来的位置；放进卡片里
    （Telegram、日志这些卡片先出标题、内容还在读）白底贴白底，不会多出一个框。原来是
    rounded-lg + border + bg-card，在卡片里就是卡中卡。
  */
  return (
    <div
      role="status" aria-live="polite"
      className={cn(
        "flex w-full items-center justify-center rounded-[var(--fx-radius-surface)] bg-[var(--fx-l1-surface)] text-muted-foreground",
        minHeight,
        className,
      )}
    >
      <div className="flex items-center gap-2 text-secondary-type">
        <Loader2 className="forwardx-icon-spin h-4 w-4" aria-hidden="true" />
        <span>{label}</span>
      </div>
    </div>
  );
}
