import { useRef, useState } from "react";

import { EntityTag } from "@/components/entity/EntityCard";
import { GroupedList, ListRow, ListSection } from "@/components/ios/GroupedList";
import { StatusDot } from "@/components/network/StatusDot";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  PIN_DURATION_OPTIONS,
  describeRoutePolicyReport,
  formatPolicyClock,
  type RoutePolicy,
  type RoutePolicyCondition,
} from "@shared/routePolicy";
import type { NetworkHealth } from "@shared/networkHealth";

/*
  主备策略面板：从规则卡上那个「主备 · 备用 1」点进来。

  回答四件事，从上往下：
    现在走哪条（以及这句话能信到什么程度）
    有哪几条（哪条是按规矩的首选，哪条在走）
    按什么选 —— 一层一行，此刻起作用的那一行高亮
    什么时候切
  最后是应急用的「强制走 / 交回自动」。

  判断全在 shared/routePolicy，这里只管画。面板底是页面灰、里面是白块（iOS 设置页那种
  分组列表）：对话框本身是一块白，白块放在白底上就看不出分组了，所以这一个对话框把
  自己当成 L0 —— 仍然是「底灰、面白」那一次底色差，没有新添一种灰。
*/

const reportHealth: Record<ReturnType<typeof describeRoutePolicyReport>["tone"], NetworkHealth> = {
  normal: "healthy",
  deviated: "degraded",
  warn: "down",
  muted: "unknown",
};

/** 选择用的小块：选中是整块反白，和主机分组、分段控件同一套 —— 选择不是状态，不染状态色。 */
function choiceClass(active: boolean) {
  return cn(
    "inline-flex h-9 min-w-0 items-center justify-center rounded-[var(--fx-radius-control)] px-3 text-sm transition-colors",
    active
      ? "bg-[var(--fx-text)] font-semibold text-[var(--fx-text-inverse)]"
      : "border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] text-muted-foreground hover:text-foreground",
  );
}

function ConditionRow({ condition }: { condition: RoutePolicyCondition }) {
  const deciding = condition.state === "deciding";
  return (
    <div
      className="fx-list-row relative flex w-full min-w-0 items-start gap-3 px-4 py-3"
      data-state={condition.state}
    >
      {/*
        高亮只用一根竖条 + 字重 + 「此刻」标记，不整行染色：整行染色在白块里就是
        又一块面，而「这一行在起作用」本来一根线就说得清。
      */}
      {deciding ? (
        <span aria-hidden="true" className="absolute inset-y-2 left-0 w-[3px] rounded-r bg-[var(--fx-path)]" />
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("text-secondary-type", deciding ? "font-semibold text-foreground" : "text-foreground")}>
          {condition.when}
        </span>
        <span className={cn("text-meta", deciding ? "text-foreground" : "text-muted-foreground")}>{condition.then}</span>
        {condition.state === "overridden" ? (
          <span className="text-meta text-[var(--fx-warn-text)]">此刻本该轮到它，被上面那条压着</span>
        ) : null}
      </span>
      {deciding ? <EntityTag tone="path">此刻</EntityTag> : null}
    </div>
  );
}

export type RoutePolicyPanelProps = {
  policy: RoutePolicy;
  /** 能不能改这条规则（强制走 / 交回自动）。 */
  canEdit: boolean;
  pending?: boolean;
  onPin: (index: number, durationSeconds: number | null) => void;
  onUnpin: () => void;
  nowMs?: number;
  timeZone?: string;
};

export function RoutePolicyPanel({ policy, canEdit, pending = false, onPin, onUnpin, nowMs, timeZone }: RoutePolicyPanelProps) {
  const now = nowMs ?? Date.now();
  const report = describeRoutePolicyReport(policy, { nowMs: now, timeZone });
  const [picking, setPicking] = useState(false);
  const [pickIndex, setPickIndex] = useState<number | null>(null);
  // 默认 2 小时，不默认「一直」：应急处理完没人记得关，时段表和自动择优就一直被压着。
  const [pickDuration, setPickDuration] = useState<number | null>(7200);
  const knowsActive = policy.lines.some((line) => line.active);
  // 老 Agent 的记录是「最近一次切到哪条」，不能说成「在走」。
  const activeTag = policy.report.kind === "lastSwitch" ? "最近切到" : "在走";
  const pinLabel = policy.pin ? policy.lines[policy.pin.index]?.label : null;

  return (
    <div className="flex min-w-0 flex-col gap-[var(--fx-space-5)]">
      <div className="flex items-start gap-2.5 px-1">
        <StatusDot health={reportHealth[report.tone]} className="mt-1.5" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-secondary-type font-semibold text-foreground">{report.text}</p>
          {policy.divergence ? <p className="text-meta text-[var(--fx-warn-text)]">{policy.divergence}</p> : null}
          {report.note ? <p className="text-meta text-muted-foreground">{report.note}</p> : null}
        </div>
      </div>

      {policy.warnings.map((warning) => (
        <p key={warning} className="rounded-[var(--fx-radius-control)] bg-[var(--fx-warn-soft)] px-3 py-2 text-meta text-[var(--fx-warn-text)]">
          {warning}
        </p>
      ))}

      <GroupedList>
        <ListSection header="线路">
          {policy.lines.map((line) => (
            <ListRow
              key={line.index}
              icon={<StatusDot health={!knowsActive ? "unknown" : line.active ? "healthy" : "standby"} />}
              label={line.label}
              detail={<span className="font-mono">{line.endpoint}</span>}
              trailing={line.active || line.preferred ? (
                <span className="flex items-center gap-1.5">
                  {line.preferred ? <EntityTag>首选</EntityTag> : null}
                  {line.active ? <EntityTag tone="path">{activeTag}</EntityTag> : null}
                </span>
              ) : undefined}
            />
          ))}
        </ListSection>

        <ListSection
          header="按什么选"
          footer={policy.strategy === "fallback"
            ? "从上往下，先对上的那一条说了算。它指的那条挂了，照样往下找。"
            : undefined}
        >
          {policy.conditions.map((condition) => <ConditionRow key={condition.key} condition={condition} />)}
        </ListSection>

        <ListSection header="什么时候切">
          {policy.guards.map((guard) => (
            <ListRow key={guard.key} label={guard.label} detail={guard.value} />
          ))}
        </ListSection>

        {policy.strategy === "fallback" && canEdit ? (
          <ListSection
            header="人工指定"
            footer="应急用：压过时段表和自动择优，到点自动交回。指定的那条要是挂了，仍然会往下切 —— 不会为了守着它把连接送进死路。"
          >
            {policy.pin ? (
              <ListRow
                label={`强制走 ${pinLabel}`}
                detail={policy.pin.untilMs ? `到 ${formatPolicyClock(policy.pin.untilMs, now, timeZone)} 自动交回` : "一直钉着，直到交回自动"}
                trailing={(
                  <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onUnpin}>
                    交回自动
                  </Button>
                )}
              />
            ) : !picking ? (
              <ListRow label="强制走一条" detail="选一条线、选多久" onSelect={() => setPicking(true)} />
            ) : (
              <div className="fx-list-row flex flex-col gap-3 px-4 py-3" data-testid="pin-picker">
                <div className="flex flex-wrap gap-2" role="group" aria-label="强制走哪条出站">
                  {policy.lines.map((line) => (
                    <button
                      key={line.index}
                      type="button"
                      aria-pressed={pickIndex === line.index}
                      className={choiceClass(pickIndex === line.index)}
                      onClick={() => setPickIndex(line.index)}
                    >
                      {line.label}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2" role="group" aria-label="强制走多久">
                  {PIN_DURATION_OPTIONS.map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      aria-pressed={pickDuration === option.seconds}
                      className={choiceClass(pickDuration === option.seconds)}
                      onClick={() => setPickDuration(option.seconds)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {pickDuration === null ? (
                  <p className="text-meta text-[var(--fx-warn-text)]">一直钉着：时段表和自动择优都不会再改变首选，直到你回来交回自动。</p>
                ) : null}
                <div className="flex items-center justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => { setPicking(false); setPickIndex(null); }}>
                    取消
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={pickIndex === null || pending}
                    onClick={() => {
                      if (pickIndex === null) return;
                      onPin(pickIndex, pickDuration);
                      // 交出去就收起来：钉上之后这一块换成「强制走 … / 交回自动」，交回之后
                      // 应该回到入口，而不是又摊开一个带着上次选择的选择器。
                      setPicking(false);
                      setPickIndex(null);
                    }}
                  >
                    {pickIndex === null ? "强制走" : `强制走 ${policy.lines[pickIndex]?.label}`}
                  </Button>
                </div>
              </div>
            )}
          </ListSection>
        ) : null}
      </GroupedList>
    </div>
  );
}

export function RoutePolicySheet({
  open,
  onOpenChange,
  ruleName,
  onEdit,
  policy,
  ...panel
}: Omit<RoutePolicyPanelProps, "policy"> & {
  policy: RoutePolicy | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ruleName: string;
  onEdit?: () => void;
}) {
  /*
    关的那一下（130ms 的动画）调用方已经把规则清掉了，拿上一份接着画 —— 不然面板在
    动画里先塌成只剩标题再消失。上一次没点完的「强制走」选择不会留着：面板在动画结束
    后整个卸掉，下次打开是新的。
  */
  const last = useRef<{ ruleName: string; policy: RoutePolicy } | null>(null);
  if (open && policy) last.current = { ruleName, policy };
  const shown = last.current;
  return (
    <Dialog open={open && !!policy} onOpenChange={onOpenChange}>
      {shown ? (
        <DialogContent className="bg-[var(--fx-l0-page)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>主备策略</DialogTitle>
            <DialogDescription className="truncate">{shown.ruleName}</DialogDescription>
          </DialogHeader>
          <RoutePolicyPanel {...panel} policy={shown.policy} />
          <DialogFooter>
            {onEdit ? (
              <Button type="button" variant="outline" onClick={onEdit}>
                编辑主备设置
              </Button>
            ) : null}
            <Button type="button" onClick={() => onOpenChange(false)}>
              完成
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
