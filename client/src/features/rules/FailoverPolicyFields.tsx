import { Fragment, useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, Trash2 } from "lucide-react";

import { EntityTag } from "@/components/entity/EntityCard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { failoverLineHintText, type FailoverLineHint, type RelayCandidate } from "@/lib/failoverRelayHints";
import type { FailoverStrategy } from "@/lib/ruleTransfer";
import { cn } from "@/lib/utils";
import {
  MAX_FAILOVER_SCHEDULE_WINDOWS,
  describeFailoverScheduleWindow,
  type FailoverSchedule,
  type FailoverScheduleWindow,
} from "@shared/failoverSchedule";
import { MAX_FAILOVER_TARGETS } from "@shared/failoverTargets";
import { PIN_DURATION_OPTIONS, formatPolicyClock, pinUntilSeconds, type RoutePolicy } from "@shared/routePolicy";
import { ConditionBlock, PolicyGroup } from "./PolicyBlocks";
import {
  FAILOVER_STRATEGY_CHOICES,
  describeFailoverPlainly,
  failoverAddressError,
  failoverRowNumbers,
  failoverRowsOf,
  failoverStrategyChoiceLabel,
  joinFailoverRow,
  splitFailoverRow,
  summarizeFailoverAdvanced,
} from "./failoverPlainText";

/*
  编辑框里「主备线路」勾上之后的那一块。

  先给第一次用的人看三样东西，其余全收进「高级设置」：

    1. 线路：主线路就是上面填的目标（只读，写明白），下面一行一条备用，「＋ 添加备用线路」。
       原来是一个多行文本框，要照着隐藏的语法写「地址:端口 探测地址:端口」，写错了
       要等点保存才弹「第 2 行：……」，还得回头数自己填的是第几行。
    2. 一句话：按现在这套设置，流量会怎么走（failoverPlainText）。不用先读懂任何一个
       控件，就知道「主线路挂了会不会自动换、会不会切回来」。
    3. 高级设置：分配方式、按什么选（人工指定 > 时段表 > 自动择优 > 按顺序）、什么时候切、
       健康检查。折起来时折叠条上列出改过默认值的项；有改过的，打开编辑框时直接展开 ——
       收纳不是藏。

  「按什么选」和规则卡上点开的主备策略面板说同一种话，从上往下就是 Agent 的优先级，
  此刻起作用的那一行标「此刻」。这个「此刻」拿**还没保存的表单**、走和面板同一份模型
  （shared/routePolicy）算 —— 改时段表、钉子、择优时当场看得见是哪一层在决定。
*/

export type FailoverPolicyValue = {
  failoverStrategy: FailoverStrategy;
  failoverTargetsText: string;
  failoverProbeTarget: string;
  failoverSchedule: FailoverSchedule | null;
  /** 人工钉住：走第几条线路、钉到什么时候（Unix 秒，null = 一直钉着）。 */
  failoverPin: { index: number; until: number | null } | null;
  failoverPreferFastest: boolean;
  failoverSeconds: number;
  recoverSeconds: number;
  failoverMinHoldSeconds: number;
  autoFailback: boolean;
};

export type FailoverPolicyFieldsProps = {
  value: FailoverPolicyValue;
  onChange: (patch: Partial<FailoverPolicyValue>) => void;
  /** 拿当前表单算出来的策略；没开主备时是 null。 */
  policy: RoutePolicy | null;
  lineHints: FailoverLineHint[];
  relayCandidates: RelayCandidate[];
  /** 主线路 = 这条规则自己的目标（`地址:端口`）；还没填是空串。 */
  mainAddress: string;
  /** 时段表按哪个时区计时。 */
  scheduleTimeZone: string;
  nowMs?: number;
  /** 钉住期限按哪个时区显示；默认看的人自己的时区。 */
  timeZone?: string;
  /** 「高级设置」一开始展不展开；不给就看有没有改过默认值。 */
  defaultAdvancedOpen?: boolean;
};

/** 小块选择（人工指定、钉多久）：选中是整块反白，和策略面板、主机分组同一套。 */
function choiceClass(active: boolean) {
  return cn(
    "inline-flex h-8 min-w-0 items-center justify-center rounded-[var(--fx-radius-control)] px-2.5 text-xs transition-colors",
    active
      ? "bg-[var(--fx-text)] font-semibold text-[var(--fx-text-inverse)]"
      : "border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] text-muted-foreground hover:text-foreground",
  );
}

/** 分配方式：名字下面带一句它会怎么做，选中同样整块反白。 */
function strategyChoiceClass(active: boolean) {
  return cn(
    "flex min-w-0 flex-col items-start gap-0.5 rounded-[var(--fx-radius-control)] px-3 py-2 text-left transition-colors",
    active
      ? "bg-[var(--fx-text)] text-[var(--fx-text-inverse)]"
      : "border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] text-foreground hover:border-[var(--fx-stroke)]",
  );
}

function SecondsField({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onChange: (seconds: number) => void;
}) {
  return (
    <FormField className="flex min-w-0 flex-col gap-1">
      <Label className="text-meta font-medium">{label}</Label>
      <div className="relative">
        <Input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={value || ""}
          onChange={(event) => onChange(parseInt(event.target.value) || 0)}
          className="h-9 pr-7"
        />
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-meta text-muted-foreground">秒</span>
      </div>
      <span className="text-meta leading-4 text-muted-foreground">{hint}</span>
    </FormField>
  );
}

export function FailoverPolicyFields({
  value,
  onChange,
  policy,
  lineHints,
  relayCandidates,
  mainAddress,
  scheduleTimeZone,
  nowMs,
  timeZone,
  defaultAdvancedOpen,
}: FailoverPolicyFieldsProps) {
  const now = nowMs ?? Date.now();
  const fallback = value.failoverStrategy === "fallback";
  const windows = value.failoverSchedule?.windows || [];
  const rows = failoverRowsOf(value.failoverTargetsText);
  const rowNumbers = failoverRowNumbers(rows);
  const backupCount = rows.filter((row) => row.trim()).length;
  // 人工指定、时段表里的「备用 N」按填好的条数数：和提交上去的顺序、Agent 的编号一致。
  const lineOptions = [
    { index: 0, label: "主线路" },
    ...Array.from({ length: backupCount }, (_, position) => ({ index: position + 1, label: `备用 ${position + 1}` })),
  ];
  const deciding = policy?.deciding ?? null;
  const conditionFor = (windowIndex: number) => policy?.conditions.find((condition) => condition.windowIndex === windowIndex);
  const advancedSummary = summarizeFailoverAdvanced({
    strategy: value.failoverStrategy,
    failoverSeconds: value.failoverSeconds,
    recoverSeconds: value.recoverSeconds,
    failoverMinHoldSeconds: value.failoverMinHoldSeconds,
    autoFailback: value.autoFailback,
    failoverProbeTarget: value.failoverProbeTarget,
    hasLineProbe: rows.some((row) => !!splitFailoverRow(row).probe),
    scheduleWindows: windows.length,
    pinned: !!value.failoverPin,
    preferFastest: value.failoverPreferFastest,
  });
  const [advancedOpen, setAdvancedOpen] = useState(() => defaultAdvancedOpen ?? advancedSummary.length > 0);
  /*
    这一次打开编辑框里选过的钉住时长。只用来标出选中的是哪一块：期限本身存的是一个时刻，
    过一秒就和任何一个「现在 + N」对不上 —— 上一版的下拉框就是这么选完就显示不出来的。
  */
  const [pinChoice, setPinChoice] = useState<number | null | undefined>(undefined);
  // 点「添加」之后把光标放进新的那一格：加完还得再点一下输入框，是多余的一步。
  const rowInputs = useRef<Array<HTMLInputElement | null>>([]);
  const [focusRow, setFocusRow] = useState<number | null>(null);
  /*
    正在输入的那一格先不报错：敲到「10.0.0.2」还没敲冒号就跳出一句「格式不对」，是在
    打断人。离开这一格（或者本来就填着）再说。
  */
  const [editingField, setEditingField] = useState<string | null>(null);
  const shownError = (field: string, error: string | null) => (editingField === field ? null : error);
  useEffect(() => {
    if (focusRow === null) return;
    rowInputs.current[focusRow]?.focus();
    setFocusRow(null);
  }, [focusRow]);

  const setRows = (next: string[]) => onChange({ failoverTargetsText: next.join("\n") });
  const patchRow = (index: number, patch: Partial<{ address: string; probe: string }>) => {
    const next = [...rows];
    next[index] = joinFailoverRow({ ...splitFailoverRow(rows[index]), ...patch });
    setRows(next);
  };
  const addRow = (address = "") => {
    // 末尾已经有一格空的，就用它 —— 连点两下「添加」不该留下两格空的。
    const last = rows.length - 1;
    const lastIsEmpty = last >= 0 && !rows[last].trim();
    if (lastIsEmpty) {
      if (address) patchRow(last, { address });
      else setFocusRow(last);
      return;
    }
    setRows([...rows, address]);
    if (!address) setFocusRow(rows.length);
  };
  const removeRow = (index: number) => setRows(rows.length > 1 ? rows.filter((_, position) => position !== index) : [""]);
  const setWindows = (next: FailoverScheduleWindow[]) => onChange({
    failoverSchedule: next.length > 0 ? { timezone: scheduleTimeZone, windows: next } : null,
  });

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <section className="flex min-w-0 flex-col gap-2" aria-label="线路" data-testid="failover-lines">
        <div className="grid min-w-0 grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5">
          <span className="text-meta text-muted-foreground">主线路</span>
          <div className="flex h-9 min-w-0 items-center gap-2 rounded-[var(--fx-radius-control)] bg-[var(--fx-l1-surface)] px-3">
            {mainAddress
              ? <span className="min-w-0 truncate font-mono text-sm">{mainAddress}</span>
              : null}
            <span className={cn("shrink-0 text-meta text-muted-foreground", mainAddress && "ml-auto")}>
              {mainAddress ? "上面填的目标" : "就是上面填的目标地址，还没填"}
            </span>
          </div>
          {rows.map((row, index) => {
            const { address } = splitFailoverRow(row);
            const error = shownError(`row-${index}`, failoverAddressError(address));
            const hint = lineHints.find((item) => item.line === index + 1);
            const hintText = hint ? failoverLineHintText(hint) : "";
            const warn = !!error || !!hint?.probeBlindSpot || hint?.sameDestination === false;
            return (
              <Fragment key={index}>
                <FormField className="contents">
                  <Label className="text-meta font-normal text-muted-foreground">备用 {rowNumbers[index]}</Label>
                  <div className="flex min-w-0 items-center gap-1">
                    <Input
                      ref={(element) => { rowInputs.current[index] = element; }}
                      value={address}
                      onChange={(event) => patchRow(index, { address: event.target.value.replace(/\s+/g, "") })}
                      onFocus={() => setEditingField(`row-${index}`)}
                      onBlur={() => setEditingField(null)}
                      placeholder="地址:端口，如 10.0.0.2:443"
                      className="h-9 font-mono text-sm"
                      spellCheck={false}
                      autoComplete="off"
                      aria-invalid={error ? true : undefined}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="fx-compact-touch h-9 w-9 shrink-0 text-muted-foreground"
                      aria-label={`删掉备用 ${rowNumbers[index]}`}
                      onClick={() => removeRow(index)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </FormField>
                {/*
                  认出来的每一条在它自己下面说清楚：是哪台中转的哪条规则、探测有没有盲区、
                  和主线路是不是同一个落地。这三件事手填时完全看不见，任何一件出错都要等
                  真出事那天才暴露。
                */}
                {error || hintText ? (
                  <p className={cn("col-start-2 text-meta leading-5", warn ? "text-[var(--fx-warn-text)]" : "text-muted-foreground")}>
                    {error || hintText}
                    {!error && hint?.probeBlindSpot ? (
                      <button type="button" className="ml-1 font-medium underline underline-offset-2" onClick={() => setAdvancedOpen(true)}>
                        去补
                      </button>
                    ) : null}
                  </p>
                ) : null}
              </Fragment>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2 pl-[3.75rem]">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="fx-compact-touch h-8 gap-1 text-meta"
            disabled={backupCount >= MAX_FAILOVER_TARGETS}
            onClick={() => addRow()}
          >
            <Plus className="h-3.5 w-3.5" />
            {backupCount >= MAX_FAILOVER_TARGETS ? `最多 ${MAX_FAILOVER_TARGETS} 条` : "添加备用线路"}
          </Button>
          {/*
            从面板认得的中转里选，而不是让人照着别处抄一个 地址:端口 过来。
            抄错了没有任何提示，要等真出事那天才发现备用线路根本连不上。
          */}
          {relayCandidates.length > 0 && backupCount < MAX_FAILOVER_TARGETS ? (
            /* 这是一个动作（挑一条加进来），不是在选一个值：用菜单，不用下拉框。 */
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="sm" className="fx-compact-touch h-8 gap-1 text-meta">
                  从已有中转里选
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                {relayCandidates.map((candidate) => (
                  <DropdownMenuItem key={candidate.id} onSelect={() => addRow(candidate.address)}>
                    {candidate.hostName} · {candidate.label}（{candidate.address}）
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </section>

      <p className="text-secondary-type leading-relaxed text-foreground" data-testid="failover-plain" aria-live="polite">
        {describeFailoverPlainly({
          strategy: value.failoverStrategy,
          backupCount,
          failoverSeconds: value.failoverSeconds,
          recoverSeconds: value.recoverSeconds,
          autoFailback: value.autoFailback,
        })}
      </p>

      <div className="flex min-w-0 flex-col border-t border-[var(--fx-stroke-weak)] pt-1">
        <button
          type="button"
          className="flex min-h-9 w-full min-w-0 items-center gap-2 text-left"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen(!advancedOpen)}
        >
          <span className="shrink-0 text-secondary-type font-medium">高级设置</span>
          {/* 折起来也得看得见里面动过什么 —— 收纳不是藏。 */}
          <span className="min-w-0 flex-1 truncate text-meta text-muted-foreground" data-testid="failover-advanced-summary">
            {advancedSummary.length > 0 ? advancedSummary.join(" · ") : "都是默认值，一般不用动"}
          </span>
          <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", advancedOpen && "rotate-180")} />
        </button>

        {advancedOpen ? (
          <div className="flex min-w-0 flex-col gap-4 pb-1 pt-2">
            <PolicyGroup title="怎么分配线路">
              <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="怎么分配线路">
                {FAILOVER_STRATEGY_CHOICES.map((choice) => {
                  const active = value.failoverStrategy === choice.value;
                  return (
                    <button
                      key={choice.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={strategyChoiceClass(active)}
                      onClick={() => onChange({ failoverStrategy: choice.value })}
                    >
                      <span className="text-secondary-type font-medium">{choice.label}</span>
                      <span className={cn("text-meta leading-4", active ? "opacity-80" : "text-muted-foreground")}>{choice.hint}</span>
                    </button>
                  );
                })}
              </div>
            </PolicyGroup>

            <PolicyGroup
              title="按什么选"
              note={fallback ? "从上往下，先对上的那一层说了算。它指的那条挂了，照样往下找 —— 选路和健康检查是两件事。" : undefined}
            >
              {(policy?.warnings || []).map((warning) => (
                <p key={warning} className="rounded-[var(--fx-radius-control)] bg-[var(--fx-warn-soft)] px-3 py-2 text-xs leading-5 text-[var(--fx-warn-text)]">
                  {warning}
                </p>
              ))}
              {!fallback ? (
                <>
                  <ConditionBlock title="每条新连接" detail={policy?.conditions[0]?.then} deciding />
                  {windows.length > 0 ? (
                    /*
                      配好时段表之后又把分配方式改成了轮流/随机/按访客：这几种没有「首选线路」，
                      时段表不适用，提交时会被归零。必须提前说 —— 保存完回来发现时段表空了，
                      比现在多一行字糟得多。界面上那份还留着，改回主备就在。
                    */
                    <p className="rounded-[var(--fx-radius-control)] bg-[var(--fx-warn-soft)] px-3 py-2 text-xs leading-5 text-[var(--fx-warn-text)]">
                      「{failoverStrategyChoiceLabel(value.failoverStrategy)}」没有首选线路，时段表不适用，保存后会清空。改回主备可以继续用。
                    </p>
                  ) : null}
                </>
              ) : (
                <div className="flex min-w-0 flex-col">
                  {/*
                    人工指定：应急时压过所有自动判断。两件事写死：钉住是「排到最前」，不是「只许走它」
                    —— 钉住的那条挂了仍然往下找；**必须有期限**，「一直」要主动选，默认 2 小时。
                  */}
                  <ConditionBlock
                    title="人工指定"
                    detail={value.failoverPin ? undefined : "应急用：强制走一条，到点自动交回"}
                    deciding={deciding === "pin"}
                    testId="policy-pin"
                  >
                    <div className="flex flex-wrap gap-1.5" role="group" aria-label="强制走哪条线路">
                      <button
                        type="button"
                        aria-pressed={!value.failoverPin}
                        className={choiceClass(!value.failoverPin)}
                        onClick={() => { setPinChoice(undefined); onChange({ failoverPin: null }); }}
                      >
                        自动
                      </button>
                      {lineOptions.map((line) => (
                        <button
                          key={line.index}
                          type="button"
                          aria-pressed={value.failoverPin?.index === line.index}
                          className={choiceClass(value.failoverPin?.index === line.index)}
                          onClick={() => {
                            if (value.failoverPin) {
                              onChange({ failoverPin: { ...value.failoverPin, index: line.index } });
                              return;
                            }
                            setPinChoice(7200);
                            onChange({ failoverPin: { index: line.index, until: pinUntilSeconds(7200, now) } });
                          }}
                        >
                          {line.label}
                        </button>
                      ))}
                    </div>
                    {value.failoverPin ? (
                      <>
                        <div className="flex flex-wrap gap-1.5" role="group" aria-label="强制走多久">
                          {PIN_DURATION_OPTIONS.map((option) => {
                            const active = option.seconds === null ? value.failoverPin!.until === null : pinChoice === option.seconds;
                            return (
                              <button
                                key={option.label}
                                type="button"
                                aria-pressed={active}
                                className={choiceClass(active)}
                                onClick={() => {
                                  setPinChoice(option.seconds);
                                  onChange({ failoverPin: { index: value.failoverPin!.index, until: pinUntilSeconds(option.seconds, now) } });
                                }}
                              >
                                {option.label}
                              </button>
                            );
                          })}
                        </div>
                        <p className="text-xs leading-5 text-[var(--fx-warn-text)]">
                          {value.failoverPin.until === null
                            ? "一直钉着：时段表和自动择优都不会再改变首选，直到你在这里改回「自动」。"
                            : `到 ${formatPolicyClock(value.failoverPin.until * 1000, now, timeZone)} 自动交回。指定的那条要是挂了，仍然会往下切。`}
                        </p>
                      </>
                    ) : null}
                  </ConditionBlock>

                  {/*
                    时段表：晚高峰错峰。它只决定「首选是谁」，切不切得过去仍然由健康检查说了算 ——
                    18 点到了而那条线正挂着，不该机械地切过去。
                  */}
                  <ConditionBlock
                    title="时段表"
                    detail={`某个时间段优先走另一条，按 ${scheduleTimeZone} 计时${windows.length === 0 ? "；没配就跳过这一层" : ""}`}
                    deciding={deciding === "schedule"}
                    showTag={false}
                    testId="policy-schedule"
                  >
                    {windows.map((window, index) => {
                      const condition = conditionFor(index);
                      const patch = (next: Partial<FailoverScheduleWindow>) => setWindows(windows.map((item, position) => (
                        position === index ? { ...item, ...next } : item
                      )));
                      return (
                        <div key={index} className="flex min-w-0 flex-col gap-1" data-state={condition?.state || "idle"}>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Select
                              value={window.days.length === 0 ? "all" : window.days.length === 2 && window.days.includes(0) ? "weekend" : "weekday"}
                              onValueChange={(days) => patch({ days: days === "all" ? [] : days === "weekend" ? [0, 6] : [1, 2, 3, 4, 5] })}
                            >
                              <SelectTrigger className="h-8 w-24 text-xs" aria-label={`第 ${index + 1} 个时段：星期`}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="all">每天</SelectItem>
                                <SelectItem value="weekday">工作日</SelectItem>
                                <SelectItem value="weekend">周末</SelectItem>
                              </SelectContent>
                            </Select>
                            <Input
                              type="time"
                              value={window.from}
                              onChange={(event) => patch({ from: event.target.value })}
                              className="h-8 w-36 text-xs sm:w-28"
                              aria-label={`第 ${index + 1} 个时段：开始时间`}
                            />
                            <span className="text-xs text-muted-foreground">至</span>
                            <Input
                              type="time"
                              value={window.to}
                              onChange={(event) => patch({ to: event.target.value })}
                              className="h-8 w-36 text-xs sm:w-28"
                              aria-label={`第 ${index + 1} 个时段：结束时间`}
                            />
                            <Select value={String(window.targetIndex)} onValueChange={(target) => patch({ targetIndex: Number(target) })}>
                              <SelectTrigger className="h-8 w-28 text-xs" aria-label={`第 ${index + 1} 个时段：优先走哪条线路`}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {lineOptions.map((line) => (
                                  <SelectItem key={line.index} value={String(line.index)}>{line.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 shrink-0"
                              aria-label={`删除第 ${index + 1} 个时段`}
                              onClick={() => setWindows(windows.filter((_, position) => position !== index))}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                            {condition?.state === "deciding" ? <EntityTag tone="path">此刻</EntityTag> : null}
                          </div>
                          {/* 配好之后用一句话复述一遍：跨午夜那一段最容易理解反。 */}
                          <p className="text-xs leading-5 text-muted-foreground">
                            {describeFailoverScheduleWindow(window)}
                            {condition?.state === "overridden" ? <span className="text-[var(--fx-warn-text)]">　此刻本该轮到它，被人工指定压着</span> : null}
                          </p>
                        </div>
                      );
                    })}
                    {windows.length < MAX_FAILOVER_SCHEDULE_WINDOWS ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 w-fit text-xs"
                        onClick={() => setWindows([...windows, { days: [1, 2, 3, 4, 5], from: "18:00", to: "01:00", targetIndex: Math.min(1, backupCount) }])}
                      >
                        添加时段
                      </Button>
                    ) : null}
                  </ConditionBlock>

                  {/*
                    不是「谁快切谁」：那样线路会一直漂。候选必须同时快过绝对门槛和百分比门槛，而且
                    连着三分钟都更快，才会被提到最前。三个数写死在 Agent 里。
                  */}
                  <ConditionBlock
                    title="自动择优"
                    detail="按实测延迟挑明显更快的那条（快 20ms 且快 20%，连续 3 分钟）"
                    deciding={deciding === "fastest"}
                    overridden={value.failoverPreferFastest && policy?.conditions.find((condition) => condition.kind === "fastest")?.state === "overridden"}
                    testId="policy-fastest"
                  >
                    <label className="flex w-fit items-center gap-2 text-sm">
                      <Checkbox
                        checked={value.failoverPreferFastest}
                        onCheckedChange={(checked) => onChange({ failoverPreferFastest: checked === true })}
                        aria-label="自动择优"
                      />
                      开启
                    </label>
                  </ConditionBlock>

                  <ConditionBlock
                    title={value.failoverPin || windows.length > 0 || value.failoverPreferFastest ? "其余时候" : "按顺序"}
                    detail={lineOptions.map((line) => line.label).join(" → ")}
                    deciding={deciding === "order"}
                    testId="policy-order"
                  />
                </div>
              )}
            </PolicyGroup>

            <PolicyGroup title="什么时候切">
              <div className={cn("grid gap-2", fallback ? "grid-cols-3" : "grid-cols-2")}>
                <SecondsField
                  label="挂了就切"
                  hint="连续检查不通多久"
                  value={value.failoverSeconds}
                  min={10}
                  max={3600}
                  onChange={(seconds) => onChange({ failoverSeconds: seconds })}
                />
                <SecondsField
                  label="恢复观察"
                  hint="恢复后要稳定多久"
                  value={value.recoverSeconds}
                  min={10}
                  max={3600}
                  onChange={(seconds) => onChange({ recoverSeconds: seconds })}
                />
                {fallback ? (
                  /*
                    最短驻留拦的是「好线路之间来回切」，不是「逃离一条死路」—— 当前这条挂了的时候
                    它不生效，守着死路比抖动更糟。只对主备有意义：轮流这类本来就不停地换。
                  */
                  <SecondsField
                    label="最短驻留"
                    hint="切过去至少走多久，0 不限"
                    value={value.failoverMinHoldSeconds}
                    min={0}
                    max={86400}
                    onChange={(seconds) => onChange({ failoverMinHoldSeconds: seconds })}
                  />
                ) : null}
              </div>
              {fallback ? (
                <label className="flex w-fit items-start gap-2 text-sm">
                  <Checkbox
                    checked={value.autoFailback}
                    onCheckedChange={(checked) => onChange({ autoFailback: checked === true })}
                    aria-label="恢复后切回"
                    className="mt-0.5"
                  />
                  <span className="flex flex-col">
                    恢复后切回首选
                    <span className="text-xs text-muted-foreground">关着的话，当前这条不出问题就一直走它</span>
                  </span>
                </label>
              ) : null}
            </PolicyGroup>

            <PolicyGroup
              title="健康检查"
              note={
                /*
                  这段必须说，而且必须说得具体：中转是 gost、realm 这类用户态转发时，连得上只说明
                  中转活着 —— 上游断了主备不会切，面板上一切正常。不写清楚他根本不会去填探测地址。
                */
                "每 5 秒对每条线路连一次 TCP。中转用 iptables/DNAT 时这一连就是端到端的；用 gost、realm 这类用户态转发时，"
                + "连得上只说明中转活着，不代表它到落地那段还通 —— 这时给它填个探测地址，指向能反映整条路径的端口。留空就探线路地址本身。"
              }
            >
              <div className="grid min-w-0 grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5">
                <FormField className="contents">
                  <Label className="text-meta font-normal text-muted-foreground">主线路</Label>
                  <Input
                    value={value.failoverProbeTarget}
                    onChange={(event) => onChange({ failoverProbeTarget: event.target.value.replace(/\s+/g, "") })}
                    onFocus={() => setEditingField("probe-main")}
                    onBlur={() => setEditingField(null)}
                    placeholder="留空就探主线路本身"
                    className="h-9 font-mono text-sm"
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={shownError("probe-main", failoverAddressError(value.failoverProbeTarget)) ? true : undefined}
                  />
                </FormField>
                {shownError("probe-main", failoverAddressError(value.failoverProbeTarget)) ? (
                  <p className="col-start-2 text-meta leading-5 text-[var(--fx-warn-text)]">{failoverAddressError(value.failoverProbeTarget)}</p>
                ) : null}
                {rows.map((row, index) => {
                  const { address, probe } = splitFailoverRow(row);
                  if (!address) return null;
                  const error = shownError(`probe-${index}`, failoverAddressError(probe));
                  return (
                    <Fragment key={index}>
                      <FormField className="contents">
                        <Label className="text-meta font-normal text-muted-foreground">备用 {rowNumbers[index]}</Label>
                        <Input
                          value={probe}
                          onChange={(event) => patchRow(index, { probe: event.target.value.replace(/\s+/g, "") })}
                          onFocus={() => setEditingField(`probe-${index}`)}
                          onBlur={() => setEditingField(null)}
                          placeholder={`留空就探 ${address}`}
                          className="h-9 font-mono text-sm"
                          spellCheck={false}
                          autoComplete="off"
                          aria-invalid={error ? true : undefined}
                        />
                      </FormField>
                      {error ? <p className="col-start-2 text-meta leading-5 text-[var(--fx-warn-text)]">{error}</p> : null}
                    </Fragment>
                  );
                })}
              </div>
            </PolicyGroup>
          </div>
        ) : null}
      </div>
    </div>
  );
}
