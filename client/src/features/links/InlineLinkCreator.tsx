import { useState } from "react";
import { Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

import {
  buildForwardGroupCreateInput,
  buildTunnelCreateInput,
  describeLinkKind,
  emptyLinkDraft,
  hostSlotLabel,
  validateLinkDraft,
  type LinkDraft,
  type LinkKind,
} from "./inlineLinkDraft";

export type HostOption = {
  id: number;
  name?: string | null;
  ip?: string | null;
  ipv4?: string | null;
  ipv6?: string | null;
};

/**
 * 在「创建转发」对话框里就地建一条线路。
 *
 * 只问必填的那几项：名字 + 机器。服务端 schema 上三十多个字段里真正没有默认值
 * 的就这些，其余（协议、限速、倍率、Proxy Protocol、健康检查……）都有默认值。
 * 要改那些仍然去线路管理页 —— 这个表单是那一页的**入口**，不是它的缩小版。
 *
 * 建完直接把新线路的 id 回调出去，外面自动选中，人可以接着填端口。中间不跳页、
 * 不关对话框：跳出去再回来，填了一半的端口和目标地址就没了。
 */
export function InlineLinkCreator({
  kind,
  hosts,
  onCreated,
  onCancel,
}: {
  kind: LinkKind;
  hosts: HostOption[];
  /**
   * 建好之后把新线路交出去。
   *
   * 隧道额外带上入口机 —— 外面选中一条隧道时本来就要跟着设 hostId，而此刻
   * 线路列表还没重新拉回来，从草稿里直接给比等一次刷新可靠。
   */
  onCreated: (created: { id: number; entryHostId?: number }) => void;
  onCancel: () => void;
}) {
  const spec = describeLinkKind(kind);
  const [draft, setDraft] = useState<LinkDraft>(() => emptyLinkDraft(kind));
  const utils = trpc.useUtils();

  /*
    主备线路整组要用同一种 DNS 记录类型，所以校验和提交都要知道每台机器有
    哪种地址。查表在这里建一次，两处共用。
  */
  const addressesById = new Map(
    hosts.map((host) => [host.id, { ipv4: host.ipv4, ipv6: host.ipv6 }]),
  );
  const problem = validateLinkDraft(kind, draft, addressesById);

  const done = (linkId: number, label: string, entryHostId?: number) => {
    toast.success(`${label}已创建`);
    onCreated({ id: linkId, entryHostId });
  };

  const createTunnel = trpc.tunnels.create.useMutation({
    onSuccess: async (result: any) => {
      await utils.tunnels.options.invalidate();
      done(Number(result?.id), "隧道", Number(draft.hostIds[0]) || undefined);
    },
    onError: (error) => toast.error(error.message || "隧道创建失败"),
  });
  const createGroup = trpc.forwardGroups.create.useMutation({
    onSuccess: async (result: any) => {
      await utils.forwardGroups.invalidate();
      done(Number(result?.id), spec.label.replace("新建", ""));
    },
    onError: (error) => toast.error(error.message || "线路创建失败"),
  });

  const pending = createTunnel.isPending || createGroup.isPending;

  const submit = () => {
    if (problem || pending) return;
    if (kind === "tunnel")
      createTunnel.mutate(buildTunnelCreateInput(draft) as any);
    else
      createGroup.mutate(
        buildForwardGroupCreateInput(kind, draft, addressesById) as any,
      );
  };

  const setHost = (index: number, hostId: number) => {
    const next = [...draft.hostIds];
    next[index] = hostId;
    setDraft({ ...draft, hostIds: next });
  };

  const canAddSlot =
    !!spec.addSlotLabel && draft.hostIds.length < spec.maxHosts;

  return (
    <div
      data-fx-inline-link={kind}
      className="flex min-w-0 flex-col gap-3 rounded-[var(--fx-radius-card)] bg-[var(--fx-l2-group)] p-3"
    >
      <div className="min-w-0">
        <p className="text-secondary-type font-medium text-foreground">
          {spec.label}
        </p>
        {/* 给第一次见到「隧道」「转发链」这些词的人一句解释，而不是假设他知道 */}
        <p className="mt-0.5 text-meta leading-relaxed text-muted-foreground">
          {spec.hint}
        </p>
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor="inline-link-name">名称</Label>
        <Input
          id="inline-link-name"
          value={draft.name}
          maxLength={128}
          placeholder="例如：港日线"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </div>

      {draft.hostIds.map((hostId, index) => (
        <div key={index} className="flex min-w-0 flex-col gap-1.5">
          <Label>{hostSlotLabel(kind, index)}</Label>
          <Select
            value={hostId ? String(hostId) : undefined}
            onValueChange={(value) => setHost(index, Number(value))}
          >
            {/*
              Label 和 Radix 的 combobox 之间没有 htmlFor/id 的关联，所以读屏
              念出来只有「combobox」。补 aria-label，名字和上面那行可见标签
              保持同一个词。
            */}
            <SelectTrigger aria-label={hostSlotLabel(kind, index)}>
              <SelectValue placeholder="选择一台机器" />
            </SelectTrigger>
            <SelectContent>
              {hosts.map((host) => (
                <SelectItem key={host.id} value={String(host.id)}>
                  {host.name || `主机 ${host.id}`}
                  {host.ip ? (
                    <span className="ml-2 text-muted-foreground">
                      {host.ip}
                    </span>
                  ) : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ))}

      {canAddSlot ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start gap-1"
          onClick={() =>
            setDraft({ ...draft, hostIds: [...draft.hostIds, null] })
          }
        >
          <Plus className="h-3.5 w-3.5" />
          {spec.addSlotLabel}
        </Button>
      ) : null}

      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        {/*
          差什么就写什么，不要只把按钮变灰 —— 一个变灰又不说原因的按钮，
          是最让人恼火的一种交互。
        */}
        {problem ? (
          <span className="mr-auto min-w-0 text-meta text-muted-foreground">
            {problem}
          </span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={pending}
        >
          取消
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={submit}
          disabled={!!problem || pending}
          className="gap-1"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          创建并使用
        </Button>
      </div>
    </div>
  );
}
