import { useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";

import { EntityTag } from "@/components/entity/EntityCard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { failoverLineHintText, type FailoverLineHint, type RelayCandidate } from "@/lib/failoverRelayHints";
import type { FailoverStrategy } from "@/lib/ruleTransfer";
import { cn } from "@/lib/utils";
import {
  MAX_FAILOVER_SCHEDULE_WINDOWS,
  describeFailoverScheduleWindow,
  type FailoverSchedule,
  type FailoverScheduleWindow,
} from "@shared/failoverSchedule";
import { PIN_DURATION_OPTIONS, formatPolicyClock, pinUntilSeconds, type RoutePolicy } from "@shared/routePolicy";

/*
  编辑框里「主备线路」开着之后的那一块。

  和规则卡上点开的主备策略面板说同一种话：线路 → 按什么选 → 什么时候切，「按什么选」
  按 Agent 的优先级从上往下排（人工指定 > 时段表 > 自动择优 > 出站顺序），此刻起作用的
  那一行标「此刻」。这个「此刻」是拿**还没保存的表单**、走和面板同一份模型
  （shared/routePolicy）算出来的 —— 改时段表、钉子、择优时当场看得见此刻是哪一层在
  决定，不用存了再去卡片上点开看。

  原来这一块是三层带边框的框套在一起，顺序也和选路优先级无关（时段表在钉子后面、
  择优混在切换时间的输入框中间），读不出「谁压过谁」。
*/

export type FailoverPolicyValue = {
  failoverStrategy: FailoverStrategy;
  failoverTargetsText: string;
  failoverProbeTarget: string;
  failoverSchedule: FailoverSchedule | null;
  /** 人工钉住：走第几条出站、钉到什么时候（Unix 秒，null = 一直钉着）。 */
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
  /** 当前策略的名字，轮询这类策略下提示时段表不适用时用。 */
  strategyLabel: string;
  /** 时段表按哪个时区计时。 */
  scheduleTimeZone: string;
  nowMs?: number;
  /** 钉住期限按哪个时区显示；默认看的人自己的时区。 */
  timeZone?: string;
};

function Group({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="text-meta font-medium text-muted-foreground">{title}</h3>
      {children}
      {note ? <p className="text-meta leading-relaxed text-muted-foreground">{note}</p> : null}
    </section>
  );
}

/** 「按什么选」里的一层。此刻在起作用的那一层左边一根路径色竖条，和策略面板同一个画法。 */
function ConditionBlock({
  title,
  detail,
  deciding,
  overridden,
  showTag = true,
  children,
  testId,
}: {
  title: string;
  detail?: ReactNode;
  deciding: boolean;
  overridden?: boolean;
  /** 时段表那一层把「此刻」标在命中的那个时段上，不标在层标题上。 */
  showTag?: boolean;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="relative flex min-w-0 flex-col gap-2 border-t border-[var(--fx-stroke-weak)] py-2.5 pl-3 first:border-t-0 first:pt-0"
      data-state={deciding ? "deciding" : overridden ? "overridden" : "idle"}
      data-testid={testId}
    >
      {deciding ? <span aria-hidden="true" className="absolute bottom-2.5 left-0 top-2.5 w-[3px] rounded-r bg-[var(--fx-path)]" /> : null}
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className={cn("text-secondary-type", deciding ? "font-semibold text-foreground" : "text-foreground")}>{title}</span>
          {detail ? <span className="text-meta text-muted-foreground">{detail}</span> : null}
          {overridden ? <span className="text-meta text-[var(--fx-warn-text)]">此刻本该轮到它，被上面那层压着</span> : null}
        </div>
        {deciding && showTag ? <EntityTag tone="path">此刻</EntityTag> : null}
      </div>
      {children}
    </div>
  );
}

/** 选择用的小块：选中是整块反白，和策略面板、主机分组同一套。 */
function choiceClass(active: boolean) {
  return cn(
    "inline-flex h-8 min-w-0 items-center justify-center rounded-[var(--fx-radius-control)] px-2.5 text-xs transition-colors",
    active
      ? "bg-[var(--fx-text)] font-semibold text-[var(--fx-text-inverse)]"
      : "border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] text-muted-foreground hover:text-foreground",
  );
}

export function FailoverPolicyFields({
  value,
  onChange,
  policy,
  lineHints,
  relayCandidates,
  strategyLabel,
  scheduleTimeZone,
  nowMs,
  timeZone,
}: FailoverPolicyFieldsProps) {
  const now = nowMs ?? Date.now();
  const fallback = value.failoverStrategy === "fallback";
  const windows = value.failoverSchedule?.windows || [];
  const lineOptions = [{ index: 0, label: "主出站" }, ...lineHints.map((hint) => ({ index: hint.line, label: `备用 ${hint.line}` }))];
  const deciding = policy?.deciding ?? null;
  const conditionFor = (windowIndex: number) => policy?.conditions.find((condition) => condition.windowIndex === windowIndex);
  /*
    这一次打开编辑框里选过的钉住时长。只用来标出选中的是哪一块：期限本身存的是一个时刻，
    过一秒就和任何一个「现在 + N」对不上 —— 上一版的下拉框就是这么选完就显示不出来的。
  */
  const [pinChoice, setPinChoice] = useState<number | null | undefined>(undefined);

  const setWindows = (next: FailoverScheduleWindow[]) => onChange({
    failoverSchedule: next.length > 0 ? { timezone: scheduleTimeZone, windows: next } : null,
  });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Group
        title="线路"
        note={
          /*
            这段必须说，而且必须说得具体：中转是 gost、realm 这类用户态转发时，连得上只说明
            中转活着 —— 上游断了主备不会切，面板上一切正常。不写清楚他根本不会去填探测目标。
          */
          "健康检查是对出站地址连一次 TCP。中转用 iptables/DNAT 时这一连就是端到端的；用 gost、realm 这类用户态转发时，"
          + "连得上只说明中转活着，不代表它到落地那段还通 —— 这时填个探测目标（每行第二个地址，空格隔开），指向能反映整条路径的端口。"
        }
      >
        <FormField className="space-y-2">
          <Label className="flex items-baseline gap-1.5">
            主出站探测目标
            <span className="text-xs font-normal text-muted-foreground">留空就探主出站地址本身</span>
          </Label>
          <Input
            value={value.failoverProbeTarget}
            onChange={(event) => onChange({ failoverProbeTarget: event.target.value })}
            placeholder="例如 10.0.0.1:9000"
            className="font-mono text-sm"
            spellCheck={false}
          />
        </FormField>
        <FormField className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label>备用出站（每行一个，最多 10 个）</Label>
            {/*
              从面板认得的中转里选，而不是让人照着别处抄一个 地址:端口 过来。
              抄错了没有任何提示，要等真出事那天才发现备用线路根本连不上。
            */}
            {relayCandidates.length > 0 ? (
              <Select
                value=""
                onValueChange={(address) => {
                  const existing = value.failoverTargetsText.replace(/\s*$/, "");
                  onChange({ failoverTargetsText: existing ? `${existing}\n${address}` : address });
                }}
              >
                <SelectTrigger className="h-8 w-auto min-w-44 text-xs" aria-label="从中转里选一条加进备用出站">
                  <SelectValue placeholder="从中转里选一条加进来" />
                </SelectTrigger>
                <SelectContent>
                  {relayCandidates.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.address}>
                      {candidate.hostName} · {candidate.label}（{candidate.address}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
          <Textarea
            value={value.failoverTargetsText}
            onChange={(event) => onChange({ failoverTargetsText: event.target.value })}
            placeholder={"10.0.0.1:80\n10.0.0.2:80  10.0.0.2:9000"}
            className="min-h-24 font-mono text-sm"
            spellCheck={false}
          />
          {/*
            认出来的每一行在这儿说清楚：是哪台中转的哪条规则、探测有没有盲区、和主出站
            是不是同一个落地。这三件事手填时完全看不见，任何一件出错都要等真出事那天才暴露。
          */}
          {lineHints.map((hint) => {
            const text = failoverLineHintText(hint);
            if (!text) return null;
            return (
              <p
                key={hint.line}
                className={cn("text-xs leading-5", hint.probeBlindSpot || hint.sameDestination === false ? "text-[var(--fx-warn-text)]" : "text-muted-foreground")}
              >
                第 {hint.line} 行：{text}
              </p>
            );
          })}
        </FormField>
      </Group>

      <Group
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
                配好时段表之后又把策略改成了轮询/随机/哈希：这几种策略没有「首选出站」，时段表
                不适用，提交时会被归零。必须提前说 —— 保存完回来发现时段表空了，比现在多一行字
                糟得多。界面上那份还留着，改回主备就在。
              */
              <p className="rounded-[var(--fx-radius-control)] bg-[var(--fx-warn-soft)] px-3 py-2 text-xs leading-5 text-[var(--fx-warn-text)]">
                {strategyLabel}下没有「首选出站」，时段表不适用，保存后会清空。改回主备模式可以继续用。
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
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="强制走哪条出站">
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
              detail={`按 ${scheduleTimeZone} 计时${windows.length === 0 ? "，没配就跳过这一层" : ""}`}
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
                        <SelectTrigger className="h-8 w-28 text-xs" aria-label={`第 ${index + 1} 个时段：优先走哪条出站`}><SelectValue /></SelectTrigger>
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
                  onClick={() => setWindows([...windows, { days: [1, 2, 3, 4, 5], from: "18:00", to: "01:00", targetIndex: 1 }])}
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
      </Group>

      <Group title="什么时候切">
        <div className={cn("grid gap-2", fallback ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
          <FormField className="space-y-2">
            <Label>切换时间（秒）</Label>
            <Input
              type="number"
              min={10}
              max={3600}
              step={1}
              value={value.failoverSeconds || ""}
              onChange={(event) => onChange({ failoverSeconds: parseInt(event.target.value) || 0 })}
            />
          </FormField>
          <FormField className="space-y-2">
            <Label>恢复观察（秒）</Label>
            <Input
              type="number"
              min={10}
              max={3600}
              step={1}
              value={value.recoverSeconds || ""}
              onChange={(event) => onChange({ recoverSeconds: parseInt(event.target.value) || 0 })}
            />
          </FormField>
          {fallback ? (
            <FormField className="space-y-2">
              {/*
                最短驻留拦的是「好线路之间来回切」，不是「逃离一条死路」—— 当前这条挂了的时候
                它不生效，守着死路比抖动更糟。只对主备有意义：轮询这类本来就不停地换。
              */}
              <Label className="flex items-baseline gap-1.5">
                最短驻留（秒）
                <span className="text-xs font-normal text-muted-foreground">0=不限</span>
              </Label>
              <Input
                type="number"
                min={0}
                max={86400}
                step={1}
                value={value.failoverMinHoldSeconds || ""}
                onChange={(event) => onChange({ failoverMinHoldSeconds: parseInt(event.target.value) || 0 })}
              />
            </FormField>
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
      </Group>
    </div>
  );
}
