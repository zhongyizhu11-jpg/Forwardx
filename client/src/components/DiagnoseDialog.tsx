import type { ReactNode } from "react";
import { Loader2, Stethoscope } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type DiagnoseOutcome = "success" | "timeout" | "failed";

/**
 * 诊断的外壳：规则、隧道、转发链三处「诊断」共用。
 *
 * 原来三处各写一份，而且同一件事有四个名字：卡片上的按钮叫「诊断」，点开标题叫「延迟探测」，
 * 底部按钮叫「链路测试」，测的时候写「探测中…」。用户按的是「诊断」，就一路叫诊断。
 *
 * 另外补了两样原来没有的：
 * - 标题下面一句「测的是什么」—— 规则是一段段测到目标地址，隧道是入口到出口，转发链是沿着
 *   链逐段测。三者看上去一样，测的范围不一样，出了问题要去查的地方也不一样。
 * - 路径下面一行「上次诊断 09-23 21:30 · 通 / 超时 / 没通」。原来打开对话框看到的是上一次
 *   的结果，却看不出是几点测的 —— 一小时前通过，不代表现在通。
 *
 * 怎么排出要测的那几段、怎么跟 Agent 要结果，各处不一样，留在各自的对话框里；这里只管人看到的部分。
 */
export function DiagnoseDialog({
  open,
  onOpenChange,
  subjectName,
  scope,
  sizeClassName,
  testing,
  lastRunAt,
  outcome,
  failureReason,
  onRun,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 诊断的是哪一个（规则名、隧道名、转发链名）。 */
  subjectName: string;
  /** 测的是什么，一句话：「从入口测到出口」。 */
  scope: string;
  sizeClassName?: string;
  testing: boolean;
  /** 上一次诊断什么时候（没有就是还没诊断过）。 */
  lastRunAt?: string | number | Date | null;
  outcome?: DiagnoseOutcome | null;
  /** 没通时的原因（Agent 报上来的那一句），有就写在结果后面。 */
  failureReason?: string | null;
  onRun: () => void;
  /** 路径和每一段的结果（LinkTestProbeView）。 */
  children: ReactNode;
}) {
  const ranBefore = !!lastRunAt && !Number.isNaN(new Date(lastRunAt).getTime());
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(sizeClassName, "min-w-0")}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Stethoscope className="h-5 w-5" aria-hidden="true" />
            诊断
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{subjectName}</span>
            <span className="text-muted-foreground"> · {scope}</span>
          </DialogDescription>
        </DialogHeader>

        {children}

        <DiagnoseStatusLine testing={testing} lastRunAt={ranBefore ? lastRunAt : null} outcome={outcome} failureReason={failureReason} />

        <DialogFooter className="gap-2">
          <Button onClick={onRun} disabled={testing} className="w-full min-w-0 gap-2 sm:w-auto sm:min-w-[112px]">
            {testing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Stethoscope className="h-4 w-4" aria-hidden="true" />}
            {testing ? "诊断中…" : ranBefore ? "重新诊断" : "开始诊断"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 「09-23 21:30」：诊断结果看的是最近几天，年份和秒都不用写。 */
export function formatDiagnoseTime(value: string | number | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const OUTCOME_TEXT: Record<DiagnoseOutcome, { text: string; className: string }> = {
  success: { text: "通", className: "text-[var(--fx-healthy-text)]" },
  timeout: { text: "超时", className: "text-[var(--fx-warn-text)]" },
  failed: { text: "没通", className: "text-[var(--fx-down-text)]" },
};

export function DiagnoseStatusLine({
  testing,
  lastRunAt,
  outcome,
  failureReason,
}: {
  testing: boolean;
  lastRunAt?: string | number | Date | null;
  outcome?: DiagnoseOutcome | null;
  failureReason?: string | null;
}) {
  let content: ReactNode;
  if (testing) {
    content = "正在诊断，结果回来后这里会更新。";
  } else if (!lastRunAt) {
    content = "还没有诊断过。";
  } else {
    const when = formatDiagnoseTime(lastRunAt);
    const result = outcome ? OUTCOME_TEXT[outcome] : null;
    const reason = outcome && outcome !== "success" ? String(failureReason || "").trim() : "";
    content = (
      <>
        上次诊断 <span className="tabular-nums">{when}</span>
        {result ? (
          <>
            {" · "}
            <span className={cn("font-medium", result.className)}>{result.text}</span>
          </>
        ) : null}
        {reason ? <span className="break-words">{`：${reason.length > 120 ? `${reason.slice(0, 120)}…` : reason}`}</span> : null}
      </>
    );
  }
  return (
    <div className="text-meta text-muted-foreground" role="status" aria-live="polite">
      {content}
    </div>
  );
}
