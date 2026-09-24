import { clipboardNeedsManualCopy, copyTextToClipboard } from "@/lib/clipboard";
import { EntityActions } from "@/components/entity/EntityActions";
import { CardActions } from "@/components/entity/EntityCard";
import { useAuth } from "@/_core/hooks/useAuth";
import { getStoredAgentTokenViewMode, storeAgentTokenViewMode, type AgentTokenViewMode } from "@/lib/agentTokenViewMode";
import { usePageVisible } from "@/hooks/usePageVisible";
import DataSectionLoading from "@/components/DataSectionLoading";
import { SortableDragHandle, SortableItem, SortableReorderContext, useOptimisticSortableOrder, useSortableReorder } from "@/components/SortableDragHandle";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Key,
  LayoutGrid,
  List,
  Loader2,
  Pencil,
  Plus,
  Server,
  ShieldCheck,
  Terminal,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { isTokenHostOnline } from "@/lib/agentTokenStatus";
import { buildAgentScriptCommand, type AgentScriptAction } from "@shared/agentInstallCommand";
import EmptyState from "@/components/EmptyState";

type AgentTokenManagerProps = {
  createSignal?: number;
  className?: string;
  showCreateButton?: boolean;
  hideViewModeToggle?: boolean;
  dialogOnly?: boolean;
  viewMode?: AgentTokenViewMode;
  onViewModeChange?: (viewMode: AgentTokenViewMode) => void;
  onCreateSignalHandled?: () => void;
  searchQuery?: string;
  onFilterStatsChange?: (stats: { filtered: number; total: number }) => void;
};

export type { AgentTokenViewMode } from "@/lib/agentTokenViewMode";
type InstallAddressMode = "public" | "current";
type InstallAddressOption = {
  id: InstallAddressMode;
  label: string;
  description: string;
  url: string;
};

function isLoopbackPanelUrl(value: string) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || host === "0.0.0.0" || host.startsWith("127.");
  } catch {
    return false;
  }
}

function normalizeConfigUrl(value: string) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function panelUrlKey(value: string) {
  return normalizeConfigUrl(value).toLowerCase();
}

function tokenHostAddress(host: any) {
  if (!host) return "";
  return host.entryIp || host.ipv4 || host.ipv6 || host.ip || "";
}

function tokenMatchesSearchQuery(tokenItem: any, query: string) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const host = tokenItem?.host;
  const status = !host
    ? tokenItem?.isUsed ? "已使用 已绑定 关联主机不存在" : "未使用 未绑定 可用"
    : isTokenHostOnline(host) ? "已使用 已绑定 在线" : "已使用 已绑定 离线";
  const haystack = [
    tokenItem?.id,
    tokenItem?.token,
    tokenItem?.description,
    status,
    host?.id,
    host?.name,
    host?.entryIp,
    host?.ipv4,
    host?.ipv6,
    host?.ip,
  ].filter((value) => value !== null && value !== undefined).join(" ").toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function TokenStatusBadge({ tokenItem }: { tokenItem: any }) {
  const host = tokenItem.host;
  if (!host) {
    return (
      <Badge variant="secondary" className="shrink-0 gap-1.5 text-[10px]">
        <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
        未绑定
      </Badge>
    );
  }

  const isOnline = isTokenHostOnline(host);
  /*
    原来「在线」用的是图表色 chart-2，圆点还带 animate-pulse —— 而 workspace.css 里有一条
    `.action-card [class*="animate-pulse"] { animation: none }` 专门把它按住：一边加动画、一边
    用猜类名的规则关掉。状态色走令牌，不闪（手册：闪动只留给「正在发生」的事）。
  */
  return isOnline ? (
    <Badge className="shrink-0 gap-1.5 border-[color-mix(in_srgb,var(--fx-healthy)_25%,transparent)] bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)] text-[10px]">
      <span className="h-2 w-2 rounded-full bg-[var(--fx-healthy)]" aria-hidden="true" />
      在线
    </Badge>
  ) : (
    <Badge className="shrink-0 gap-1.5 border-[color-mix(in_srgb,var(--fx-down)_25%,transparent)] bg-[var(--fx-down-soft)] text-[var(--fx-down-text)] text-[10px]">
      <span className="h-2 w-2 rounded-full bg-[var(--fx-down)]" aria-hidden="true" />
      离线
    </Badge>
  );
}

function TokenHostInfo({ tokenItem, compact = false }: { tokenItem: any; compact?: boolean }) {
  if (!tokenItem.host) {
    return <span className="text-xs text-muted-foreground">{tokenItem.isUsed ? "关联主机不存在" : "-"}</span>;
  }
  const address = tokenHostAddress(tokenItem.host);
  return (
    <div className={`flex min-w-0 items-center gap-2 text-xs leading-5 ${compact ? "" : "max-w-[240px]"}`}>
      <span className="flex h-9 w-7 shrink-0 items-center justify-center rounded-md bg-muted/40">
        <Server className="h-3.5 w-3.5 text-muted-foreground" />
      </span>
      <div className="min-w-0">
        <span className="block truncate font-medium" title={tokenItem.host.name}>
          {tokenItem.host.name}
        </span>
        {address && (
          <span className="block truncate font-mono text-muted-foreground" title={address}>
            {address}
          </span>
        )}
      </div>
    </div>
  );
}

function TokenActionButtons({
  tokenItem,
  loadingScriptTokenId,
  onOpenScript,
  onEdit,
  onDelete,
}: {
  tokenItem: any;
  loadingScriptTokenId: number | null;
  onOpenScript: (id: number) => void;
  onEdit: (tokenItem: any) => void;
  onDelete: (tokenItem: any) => void;
}) {
  // 原来是三个只有悬停提示、没有读屏名字的图标；拿安装命令是这里最常做的事，带字放外面。
  const loading = loadingScriptTokenId === tokenItem.id;
  const name = tokenItem.remark || tokenItem.name || `Token #${tokenItem.id}`;
  return (
    <EntityActions
      primary={[
        {
          key: "script",
          label: "安装命令",
          ariaLabel: `查看 ${name} 的安装命令`,
          icon: loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Terminal className="h-3.5 w-3.5" />,
          disabled: loading,
          onSelect: () => onOpenScript(tokenItem.id),
        },
        { key: "edit", label: "编辑", ariaLabel: `编辑 ${name} 的备注`, icon: <Pencil className="h-3.5 w-3.5" />, onSelect: () => onEdit(tokenItem) },
      ]}
      menu={[{ key: "delete", label: "删除", ariaLabel: `删除 ${name}`, icon: <Trash2 className="h-3.5 w-3.5" />, destructive: true, onSelect: () => onDelete(tokenItem) }]}
      menuLabel={`${name} 的更多操作`}
    />
  );
}

function AgentTokenCard({
  tokenItem,
  loadingScriptTokenId,
  onOpenScript,
  onEdit,
  onDelete,
  dragHandle,
  sortableClassName,
}: {
  tokenItem: any;
  loadingScriptTokenId: number | null;
  onOpenScript: (id: number) => void;
  onEdit: (tokenItem: any) => void;
  onDelete: (tokenItem: any) => void;
  dragHandle?: any;
  sortableClassName?: string;
}) {
  const description = typeof tokenItem.description === "string" ? tokenItem.description.trim() : "";
  const createdAtText = new Date(tokenItem.createdAt).toLocaleString();

  return (
    <Card className={cn("action-card group/sortable border-border bg-card", sortableClassName)}>
      <CardContent className="action-card-content space-y-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Key className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={description || "Agent Token"}>
                  {description || "Agent Token"}
                </p>
                <p
                  className="truncate text-xs text-muted-foreground"
                  title={`创建时间：${createdAtText}`}
                >
                  创建时间 · {createdAtText}
                </p>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {dragHandle}
            <TokenStatusBadge tokenItem={tokenItem} />
          </div>
        </div>

        <code className="block break-all rounded-md border border-border/40 bg-background/60 px-3 py-2 font-mono text-xs">
          {tokenItem.token}
        </code>

        <div className="rounded-md bg-muted/25 p-3">
          <p className="mb-2 text-xs text-muted-foreground">对应主机</p>
          <TokenHostInfo tokenItem={tokenItem} compact />
        </div>

        <CardActions>
          <TokenActionButtons
            tokenItem={tokenItem}
            loadingScriptTokenId={loadingScriptTokenId}
            onOpenScript={onOpenScript}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        </CardActions>
      </CardContent>
    </Card>
  );
}

function CommandRow({
  label,
  command,
  onCopy,
  copyDisabled,
}: {
  label: string;
  command: string;
  onCopy: () => void;
  copyDisabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <div className="min-w-0 overflow-hidden rounded border bg-muted/30">
          <div className="h-12 overflow-x-scroll overflow-y-hidden">
            <code className="flex h-full w-max min-w-full items-center whitespace-nowrap px-3 pb-3 pt-2 font-mono text-xs leading-5">
              {command}
            </code>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon" aria-label="复制安装命令"
          className="h-10 w-10 shrink-0"
          aria-disabled={copyDisabled}
          onClick={() => {
            if (copyDisabled) return;
            onCopy();
          }}
        >
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function InstallAddressSelector({
  options,
  selectedId,
  onChange,
}: {
  options: InstallAddressOption[];
  selectedId: InstallAddressMode;
  onChange: (value: InstallAddressMode) => void;
}) {
  if (options.length <= 1) return null;
  return (
    <div className="space-y-2 rounded-lg border border-border/50 bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">安装连接地址</p>
          <p className="text-xs text-muted-foreground">
            需要直连 IP 和端口时，请选择“当前访问地址”。
          </p>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const active = option.id === selectedId;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(option.id)}
              className={cn(
                "min-w-0 rounded-md border px-3 py-2 text-left transition-colors",
                active
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border/50 bg-background/70 hover:bg-muted/50",
              )}
            >
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground" title={option.url}>
                {option.url}
              </span>
              <span className="mt-1 block text-[11px] text-muted-foreground">
                {option.description}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function AgentTokenManager({
  createSignal,
  className,
  showCreateButton = true,
  hideViewModeToggle = false,
  dialogOnly = false,
  viewMode: controlledViewMode,
  onViewModeChange,
  onCreateSignalHandled,
  searchQuery = "",
  onFilterStatsChange,
}: AgentTokenManagerProps) {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const pageVisible = usePageVisible();
  const [showCreate, setShowCreate] = useState(false);
  const [showNewToken, setShowNewToken] = useState(false);
  const [showScript, setShowScript] = useState(false);
  const [scriptToken, setScriptToken] = useState("");
  const [loadingScriptTokenId, setLoadingScriptTokenId] = useState<number | null>(null);
  const [newToken, setNewToken] = useState("");
  const [description, setDescription] = useState("");
  const [editingToken, setEditingToken] = useState<any>(null);
  const [editDescription, setEditDescription] = useState("");
  const [tokenToDelete, setTokenToDelete] = useState<any | null>(null);
  const [internalViewMode, setInternalViewMode] = useState<AgentTokenViewMode>(() => getStoredAgentTokenViewMode());
  const [installAddressMode, setInstallAddressMode] = useState<InstallAddressMode>("public");
  const lastCreateSignalRef = useRef(0);
  const viewMode = controlledViewMode ?? internalViewMode;

  const openCreateDialog = () => {
    setDescription("");
    setShowCreate(true);
  };

  const handleViewModeChange = (nextViewMode: AgentTokenViewMode) => {
    if (onViewModeChange) onViewModeChange(nextViewMode);
    else setInternalViewMode(nextViewMode);
    storeAgentTokenViewMode(nextViewMode);
  };

  useEffect(() => {
    if (!createSignal) {
      lastCreateSignalRef.current = 0;
      return;
    }
    if (createSignal === lastCreateSignalRef.current) return;
    lastCreateSignalRef.current = createSignal;
    openCreateDialog();
    onCreateSignalHandled?.();
  }, [createSignal]);

  const { data: tokens, isLoading } = trpc.agentTokens.list.useQuery(
    undefined,
    {
      enabled: user?.role === "admin" && !dialogOnly,
      refetchInterval: !dialogOnly && pageVisible ? 2000 : false,
      refetchOnWindowFocus: true,
    }
  );
  const tokenItems = useMemo(() => (tokens as any[] | undefined) || [], [tokens]);
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const isTextFiltered = normalizedSearchQuery.length > 0;
  const filteredTokenItems = useMemo(
    () => isTextFiltered
      ? tokenItems.filter((tokenItem: any) => tokenMatchesSearchQuery(tokenItem, normalizedSearchQuery))
      : tokenItems,
    [isTextFiltered, normalizedSearchQuery, tokenItems],
  );
  const tokenOrder = useOptimisticSortableOrder({
    items: filteredTokenItems,
    getId: (tokenItem: any) => Number(tokenItem.id),
  });
  const displayedTokenItems = tokenOrder.items;
  useEffect(() => {
    onFilterStatsChange?.({ filtered: filteredTokenItems.length, total: tokenItems.length });
  }, [filteredTokenItems.length, onFilterStatsChange, tokenItems.length]);

  const { data: systemSettings } = trpc.system.getSettings.useQuery();
  const configuredPanelUrl = normalizeConfigUrl(systemSettings?.panelPublicUrl || "");
  const currentPanelUrl = typeof window !== "undefined" ? normalizeConfigUrl(window.location.origin) : "";
  const panelUrl = configuredPanelUrl || currentPanelUrl;
  const installAddressOptions = useMemo<InstallAddressOption[]>(() => {
    const options: InstallAddressOption[] = [];
    if (configuredPanelUrl) {
      options.push({
        id: "public",
        label: "公开域名",
        description: "系统设置中的公开地址。",
        url: configuredPanelUrl,
      });
    }
    if (currentPanelUrl && (!configuredPanelUrl || panelUrlKey(currentPanelUrl) !== panelUrlKey(configuredPanelUrl))) {
      options.push({
        id: "current",
        label: configuredPanelUrl ? "当前访问地址" : "默认地址",
        description: configuredPanelUrl ? "当前浏览器使用的地址。" : "当前面板地址。",
        url: currentPanelUrl,
      });
    }
    if (options.length === 0 && panelUrl) {
      options.push({
        id: "current",
        label: "默认地址",
        description: "当前面板地址。",
        url: panelUrl,
      });
    }
    return options;
  }, [configuredPanelUrl, currentPanelUrl, panelUrl]);
  useEffect(() => {
    if (installAddressOptions.length === 0) return;
    if (!installAddressOptions.some((option) => option.id === installAddressMode)) {
      setInstallAddressMode(installAddressOptions[0].id);
    }
  }, [installAddressMode, installAddressOptions]);
  const activeInstallAddress = installAddressOptions.find((option) => option.id === installAddressMode) || installAddressOptions[0];
  const commandPanelUrl = activeInstallAddress?.url || panelUrl;
  const panelUrlUsesLoopback = isLoopbackPanelUrl(commandPanelUrl);
  const githubAcceleratorUrl = normalizeConfigUrl(systemSettings?.githubAccelerator?.url || "");
  const githubAcceleratorActive = !!systemSettings?.githubAccelerator?.enabled && !!githubAcceleratorUrl;
  const agentPreferPanelInstall = !!systemSettings?.agentPreferPanelInstall;

  const createTokenMutation = trpc.agentTokens.create.useMutation({
    onSuccess: (data) => {
      utils.agentTokens.list.invalidate();
      toast.success("安装 Token 已生成");
      setNewToken(data.token);
      setShowNewToken(true);
      setShowCreate(false);
    },
    onError: (err) => toast.error(err.message || "生成 Token 失败"),
  });

  const deleteTokenMutation = trpc.agentTokens.delete.useMutation({
    onSuccess: (data) => {
      utils.agentTokens.list.invalidate();
      utils.hosts.list.invalidate();
      utils.hosts.options.invalidate();
      utils.hosts.listPage.invalidate();
      utils.hosts.summary.invalidate();
      utils.hosts.statusSummary.invalidate();
      const released = Number(data?.releasedPendingCleanup || 0);
      const removedHosts = Number(data?.removedHosts || 0);
      toast.success(released > 0
        ? `Token 已删除，已释放 ${released} 条待清理规则并移除 ${removedHosts} 台关联主机`
        : removedHosts > 0
          ? `Token 已删除，已移除 ${removedHosts} 台关联主机`
          : "Token 已删除");
    },
    onError: (err) => toast.error(err.message || "删除 Token 失败"),
  });

  const updateTokenMutation = trpc.agentTokens.update.useMutation({
    onSuccess: () => {
      utils.agentTokens.list.invalidate();
      toast.success("Token 备注已更新");
      setEditingToken(null);
      setEditDescription("");
    },
    onError: (err) => toast.error(err.message || "更新 Token 备注失败"),
  });
  const reorderTokenMutation = trpc.agentTokens.reorder.useMutation({
    onSuccess: () => toast.success("Token 顺序已更新"),
    onError: (err) => toast.error(err.message || "更新 Token 顺序失败"),
  });
  const tokenReorderPending = reorderTokenMutation.isPending;
  const tokenSortable = useSortableReorder({
    items: displayedTokenItems,
    getId: (tokenItem: any) => Number(tokenItem.id),
    disabled: isTextFiltered || tokenReorderPending || displayedTokenItems.length < 2,
    onReorder: (nextTokens) => {
      const requestId = tokenOrder.begin(nextTokens);
      reorderTokenMutation.mutate(
        { ids: nextTokens.map((tokenItem: any) => Number(tokenItem.id)) },
        {
          onError: () => tokenOrder.release(requestId),
          onSettled: () => tokenOrder.resync(requestId, () => utils.agentTokens.list.invalidate()),
        },
      );
    },
  });

  const openScriptDialog = async (tokenId: number) => {
    try {
      setLoadingScriptTokenId(tokenId);
      const data = await utils.agentTokens.getInstallToken.fetch({ id: tokenId });
      setScriptToken(data.token);
      setShowScript(true);
    } catch (err: any) {
      toast.error(err?.message || "获取安装命令失败");
    } finally {
      setLoadingScriptTokenId(null);
    }
  };

  const copyToClipboard = async (text: string) => {
    /*
      走共享实现，不再在这里自己拼一遍 textarea。

      共享那份的注释写明了为什么：textarea 那条路 Chromium 会返回 true 其实复制了个空，
      iOS 直接不认 —— 它改用了 contenteditable + Range。这里原来抄的正是被换掉的旧写法。
    */
    if (await copyTextToClipboard(text)) {
      toast.success("已复制到剪贴板");
      return;
    }
    toast.error(
      clipboardNeedsManualCopy()
        ? "当前是 http 访问，浏览器限制了剪贴板，请长按选中内容复制"
        : "复制失败，请手动复制",
    );
  };

  /**
   * 命令怎么拼在 shared/agentInstallCommand.ts 里，服务端给租户拼的是同一份 ——
   * 这里再抄一遍的话，改了一边忘了另一边，谁也不会发现，直到有人拿着过时的
   * 命令去装机器。
   */
  const getAgentScriptCommand = (action: AgentScriptAction, token?: string, targetPanelUrl = commandPanelUrl) =>
    buildAgentScriptCommand({
      panelUrl: normalizeConfigUrl(targetPanelUrl) || panelUrl,
      action,
      token,
      githubAcceleratorUrl,
      githubAcceleratorEnabled: githubAcceleratorActive,
      preferPanelInstall: agentPreferPanelInstall,
    });

  const getInstallCommand = (token: string) => getAgentScriptCommand("install", token);
  const getUninstallCommand = () => getAgentScriptCommand("uninstall");
  const getUpgradeCommand = () => getAgentScriptCommand("upgrade");
  const openEditToken = (tokenItem: any) => {
    setEditingToken(tokenItem);
    setEditDescription(tokenItem.description || "");
  };

  if (user?.role !== "admin") return null;

  return (
    <div className={dialogOnly ? "contents" : `space-y-4 ${className || ""}`}>
      {!dialogOnly && (
      <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          生成 Agent 安装命令；上线后自动绑定到面板。
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {!hideViewModeToggle && <div className="hidden items-center overflow-hidden rounded-md border border-border/40 sm:flex">
            <Button
              variant={viewMode === "card" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              title="卡片视图"
              onClick={() => handleViewModeChange("card")}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "table" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              title="列表视图"
              onClick={() => handleViewModeChange("table")}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>}
          {showCreateButton && (
            <Button onClick={openCreateDialog} className="w-full gap-2 sm:w-auto">
              <Plus className="h-4 w-4" />
              添加主机
            </Button>
          )}
        </div>
      </div>

      <Alert className="border-[color-mix(in_srgb,var(--fx-healthy)_25%,transparent)] bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)]">
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>通讯已加密</AlertTitle>
      </Alert>

      <Card className="border-border bg-card">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4">
              <DataSectionLoading label="正在加载 Agent Token" />
            </div>
          ) : displayedTokenItems.length > 0 ? (
            <>
              {viewMode === "card" ? (
                <SortableReorderContext sortable={tokenSortable} ids={displayedTokenItems.map((tokenItem: any) => Number(tokenItem.id))} strategy="rect">
                  <div key="agent-token-card-view" className="standard-card-grid card-mode-transition gap-4 p-3">
                    {displayedTokenItems.map((tokenItem: any) => (
                      <SortableItem key={tokenItem.id} id={Number(tokenItem.id)} disabled={tokenSortable.disabled}>
                        {({ itemProps, handleProps, isDragging, isDropTarget }) => (
                          <div {...itemProps}>
                            <AgentTokenCard
                              tokenItem={tokenItem}
                              loadingScriptTokenId={loadingScriptTokenId}
                              onOpenScript={openScriptDialog}
                              onEdit={openEditToken}
                              onDelete={setTokenToDelete}
                              dragHandle={<SortableDragHandle dragHandleProps={handleProps} visible={isDragging} busy={tokenReorderPending} />}
                              sortableClassName={cn(isDragging && "opacity-55 ring-1 ring-primary/35", isDropTarget && "ring-1 ring-primary/45")}
                            />
                          </div>
                        )}
                      </SortableItem>
                    ))}
                  </div>
                </SortableReorderContext>
              ) : (
              <div key="agent-token-table-view" className="card-mode-transition">
              <SortableReorderContext sortable={tokenSortable} ids={displayedTokenItems.map((tokenItem: any) => Number(tokenItem.id))} strategy="vertical" restrictToList>
                <div className="grid grid-cols-1 gap-4 p-3 sm:hidden">
                  {displayedTokenItems.map((tokenItem: any) => (
                    <SortableItem key={tokenItem.id} id={Number(tokenItem.id)} disabled={tokenSortable.disabled}>
                      {({ itemProps, handleProps, isDragging, isDropTarget }) => (
                        <div {...itemProps}>
                          <AgentTokenCard
                            tokenItem={tokenItem}
                            loadingScriptTokenId={loadingScriptTokenId}
                            onOpenScript={openScriptDialog}
                            onEdit={openEditToken}
                            onDelete={setTokenToDelete}
                            dragHandle={<SortableDragHandle dragHandleProps={handleProps} visible={isDragging} busy={tokenReorderPending} />}
                            sortableClassName={cn(isDragging && "opacity-55 ring-1 ring-primary/35", isDropTarget && "ring-1 ring-primary/45")}
                          />
                        </div>
                      )}
                    </SortableItem>
                  ))}
                </div>
              </SortableReorderContext>
              <div className="hidden overflow-x-auto sm:block">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-[44px]" />
                      <TableHead>Token</TableHead>
                      <TableHead className="hidden sm:table-cell">描述</TableHead>
                      <TableHead>主机状态</TableHead>
                      <TableHead>对应主机</TableHead>
                      <TableHead className="hidden md:table-cell">创建时间</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <SortableReorderContext sortable={tokenSortable} ids={displayedTokenItems.map((tokenItem: any) => Number(tokenItem.id))} strategy="vertical" restrictToList>
                  <TableBody>
                    {displayedTokenItems.map((tokenItem: any) => (
                      <SortableItem key={tokenItem.id} id={Number(tokenItem.id)} disabled={tokenSortable.disabled} itemKind="row">
                        {({ itemProps, handleProps, isDragging, isDropTarget }) => (
                      <TableRow
                        {...itemProps}
                        className={cn(
                          "group/sortable",
                          isDragging && "opacity-55 ring-1 ring-primary/35",
                          isDropTarget && "ring-1 ring-primary/45",
                        )}
                      >
                        <TableCell className="w-[44px] px-2">
                          <SortableDragHandle dragHandleProps={handleProps} visible={isDragging} busy={tokenReorderPending} />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <code className="text-xs bg-muted/40 px-2 py-1 rounded font-mono">
                              {tokenItem.token}
                            </code>
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <span className="text-sm text-muted-foreground">{tokenItem.description || "-"}</span>
                        </TableCell>
                        <TableCell>
                          <TokenStatusBadge tokenItem={tokenItem} />
                        </TableCell>
                        <TableCell>
                          <TokenHostInfo tokenItem={tokenItem} />
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <span className="text-xs text-muted-foreground">
                            {new Date(tokenItem.createdAt).toLocaleString()}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <TokenActionButtons
                            tokenItem={tokenItem}
                            loadingScriptTokenId={loadingScriptTokenId}
                            onOpenScript={openScriptDialog}
                            onEdit={openEditToken}
                            onDelete={setTokenToDelete}
                          />
                        </TableCell>
                      </TableRow>
                        )}
                      </SortableItem>
                    ))}
                  </TableBody>
                  </SortableReorderContext>
                </Table>
              </div>
              </div>
              )}
            </>
          ) : (
            <EmptyState
              icon={<Key />}
              title={isTextFiltered && tokenItems.length > 0 ? "未找到匹配 Token" : "暂无 Token"}
              description={isTextFiltered && tokenItems.length > 0 ? "调整筛选内容或清空搜索" : "添加主机后会生成 Agent 安装命令"}
              actions={showCreateButton ? (
                <Button onClick={openCreateDialog} variant="outline" className="gap-2">
                  <Plus className="h-4 w-4" />
                  添加主机
                </Button>
              ) : undefined}
            />
          )}
        </CardContent>
      </Card>
      </>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加主机</DialogTitle>
            <DialogDescription>
              先生成 Agent 安装 Token，再复制命令到目标主机执行。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>描述（可选）</Label>
              <Input
                placeholder="例如: 香港节点 Agent"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              取消
            </Button>
            <Button
              onClick={() => createTokenMutation.mutate({ description: description || undefined })}
              disabled={createTokenMutation.isPending}
            >
              生成安装命令
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showNewToken} onOpenChange={setShowNewToken}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-chart-2" />
              安装命令已生成
            </DialogTitle>
            <DialogDescription>
              在目标主机执行命令；Agent 上线后会出现在主机列表。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <InstallAddressSelector
              options={installAddressOptions}
              selectedId={installAddressMode}
              onChange={setInstallAddressMode}
            />
            {panelUrlUsesLoopback && (
              <Alert className="border-[color-mix(in_srgb,var(--fx-warn)_30%,transparent)] bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)]">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>当前安装地址是本机回环地址</AlertTitle>
                <AlertDescription>
                  Agent 作为服务运行时访问 localhost、127.0.0.1 或 ::1 可能指向 Agent 自己，面板机部署 Agent 连接自己时容易不上线。请在系统设置里配置面板公开访问地址，或用实际 IP/域名打开面板后再复制命令。
                </AlertDescription>
              </Alert>
            )}
            <div className="space-y-2">
              <p className="text-sm font-medium">快速安装命令：</p>
              <div className="p-3 rounded-lg bg-background/50 border">
                <code className="text-xs font-mono break-all">
                  {getInstallCommand(newToken)}
                </code>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full gap-2"
                onClick={() => copyToClipboard(getInstallCommand(newToken))}
              >
                <Copy className="h-3 w-3" />
                复制安装命令
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setShowNewToken(false)}>确定</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingToken} onOpenChange={(open) => {
        if (!open) {
          setEditingToken(null);
          setEditDescription("");
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑 Token 备注</DialogTitle>
            <DialogDescription>
              备注会作为新主机默认名称。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>备注</Label>
            <Input
              value={editDescription}
              maxLength={200}
              placeholder="例如：香港节点 Agent"
              onChange={(event) => setEditDescription(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingToken(null)}>
              取消
            </Button>
            <Button
              disabled={updateTokenMutation.isPending || !editingToken}
              onClick={() => updateTokenMutation.mutate({
                id: editingToken.id,
                description: editDescription.trim() || null,
              })}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!tokenToDelete} onOpenChange={(open) => !open && setTokenToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              删除 Agent Token
            </DialogTitle>
            <DialogDescription>
              删除后该 Token 将失效；如果关联主机没有转发规则、转发组或隧道引用，会同步从主机管理中移除。
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border/50 bg-muted/30 p-3 text-sm">
            <div className="font-mono break-all">{tokenToDelete?.token}</div>
            {tokenToDelete?.description && (
              <div className="mt-2 text-xs text-muted-foreground">{tokenToDelete.description}</div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTokenToDelete(null)}>取消</Button>
            <Button
              variant="destructive"
              disabled={deleteTokenMutation.isPending || !tokenToDelete}
              onClick={() => {
                if (!tokenToDelete) return;
                const id = tokenToDelete.id;
                setTokenToDelete(null);
                deleteTokenMutation.mutate({ id });
              }}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showScript} onOpenChange={(open) => {
        setShowScript(open);
        if (!open) setScriptToken("");
      }}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-[42rem] sm:w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Terminal className="h-5 w-5" />
              安装命令
            </DialogTitle>
            <DialogDescription>
              使用 root 执行命令。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <InstallAddressSelector
              options={installAddressOptions}
              selectedId={installAddressMode}
              onChange={setInstallAddressMode}
            />
            {panelUrlUsesLoopback && (
              <Alert className="border-[color-mix(in_srgb,var(--fx-warn)_30%,transparent)] bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)]">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>当前安装地址是本机回环地址</AlertTitle>
                <AlertDescription>
                  Agent 作为服务运行时访问 localhost、127.0.0.1 或 ::1 可能指向 Agent 自己，面板机部署 Agent 连接自己时容易不上线。请在系统设置里配置面板公开访问地址，或用实际 IP/域名打开面板后再复制命令。
                </AlertDescription>
              </Alert>
            )}
            <CommandRow
              label="安装命令"
              command={scriptToken ? getInstallCommand(scriptToken) : ""}
              copyDisabled={!scriptToken}
              onCopy={() => scriptToken && copyToClipboard(getInstallCommand(scriptToken))}
            />
            <CommandRow
              label="卸载命令"
              command={getUninstallCommand()}
              onCopy={() => copyToClipboard(getUninstallCommand())}
            />
            <CommandRow
              label="升级命令"
              command={getUpgradeCommand()}
              onCopy={() => copyToClipboard(getUpgradeCommand())}
            />
          </div>
          <DialogFooter>
            <Button onClick={() => {
              setShowScript(false);
              setScriptToken("");
            }}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
