import DashboardLayout from "@/components/DashboardLayout";
import DataSectionLoading from "@/components/DataSectionLoading";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import {
  PROXY_NODE_PROTOCOL_LABELS,
  type ProxyNodeProtocol,
} from "@shared/proxyNode";
import {
  PROXY_SUBSCRIPTION_FORMATS,
  PROXY_SUBSCRIPTION_FORMAT_HINTS,
  PROXY_SUBSCRIPTION_FORMAT_LABELS,
  type ProxySubscriptionFormat,
} from "@shared/proxySubscription";
import {
  PROXY_NODE_AUTO_GROUPS,
  PROXY_NODE_AUTO_GROUP_HINTS,
  PROXY_NODE_AUTO_GROUP_LABELS,
  normalizeProxyNodeAutoGroup,
  type ProxyNodeAutoGroup,
} from "@shared/proxySubscriptionPlan";
import { Copy, Eye, EyeOff, Link2, Plus, RefreshCw, Server, Trash2, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

function subscriptionUrl(token: string, format: ProxySubscriptionFormat) {
  const base = `${window.location.origin}/api/sub/${token}`;
  // 通用格式不带参数，方便直接粘进老客户端；其余格式显式指定，避免 UA 识别失败。
  return format === "base64" ? base : `${base}?format=${format}`;
}

async function copyText(value: string, message: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(message);
  } catch {
    toast.error("复制失败，请手动选中复制");
  }
}

export default function ClientSubscriptionsPage() {
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();

  const nodesQuery = trpc.proxySubscriptions.listNodes.useQuery();
  const tokensQuery = trpc.proxySubscriptions.listTokens.useQuery();
  const previewQuery = trpc.proxySubscriptions.preview.useQuery();

  const [nodeDialogOpen, setNodeDialogOpen] = useState(false);
  const [editingNodeId, setEditingNodeId] = useState<number | null>(null);
  const [nodeName, setNodeName] = useState("");
  const [nodeLink, setNodeLink] = useState("");
  const [nodeAutoGroup, setNodeAutoGroup] = useState<ProxyNodeAutoGroup>("url-test");
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [tokenFormat, setTokenFormat] = useState<ProxySubscriptionFormat>("base64");

  const refresh = () => {
    void utils.proxySubscriptions.listNodes.invalidate();
    void utils.proxySubscriptions.listTokens.invalidate();
    void utils.proxySubscriptions.preview.invalidate();
  };

  const createNode = trpc.proxySubscriptions.createNode.useMutation({
    onSuccess: () => {
      toast.success("客户端节点已添加");
      setNodeDialogOpen(false);
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const updateNode = trpc.proxySubscriptions.updateNode.useMutation({
    onSuccess: () => {
      toast.success("客户端节点已更新");
      setNodeDialogOpen(false);
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const deleteNode = trpc.proxySubscriptions.deleteNode.useMutation({
    onSuccess: (result) => {
      toast.success(
        result.releasedRules > 0
          ? `节点已删除，${result.releasedRules} 条转发已解绑（转发本身继续运行）`
          : "节点已删除",
      );
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const bindRule = trpc.proxySubscriptions.bindRule.useMutation({
    onSuccess: () => {
      toast.success("已加入订阅");
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const setRuleVisible = trpc.proxySubscriptions.setRuleVisible.useMutation({
    onSuccess: () => refresh(),
    onError: (error) => toast.error(error.message),
  });
  const createToken = trpc.proxySubscriptions.createToken.useMutation({
    onSuccess: () => {
      toast.success("订阅链接已创建");
      setTokenDialogOpen(false);
      setTokenName("");
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const updateToken = trpc.proxySubscriptions.updateToken.useMutation({
    onSuccess: () => refresh(),
    onError: (error) => toast.error(error.message),
  });
  const rotateToken = trpc.proxySubscriptions.rotateToken.useMutation({
    onSuccess: () => {
      toast.success("订阅地址已重置，旧地址立即失效");
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const deleteToken = trpc.proxySubscriptions.deleteToken.useMutation({
    onSuccess: () => {
      toast.success("订阅链接已删除");
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const nodes = nodesQuery.data ?? [];
  const tokens = tokensQuery.data ?? [];
  const preview = previewQuery.data;

  // 只有「已隐藏」需要一键恢复，其他原因要用户自己去改转发或模板。
  const hiddenRules = useMemo(
    () => (preview?.skipped ?? []).filter((item) => item.reason === "hidden"),
    [preview],
  );
  const unboundRules = useMemo(
    () => (preview?.skipped ?? []).filter((item) => item.reason === "unbound"),
    [preview],
  );
  const otherSkipped = useMemo(
    () => (preview?.skipped ?? []).filter((item) => item.reason !== "hidden" && item.reason !== "unbound"),
    [preview],
  );
  const enabledNodes = useMemo(() => nodes.filter((node: any) => node.isEnabled), [nodes]);

  const openCreateNode = () => {
    setEditingNodeId(null);
    setNodeName("");
    setNodeLink("");
    setNodeAutoGroup("url-test");
    setNodeDialogOpen(true);
  };

  const openEditNode = (node: any) => {
    setEditingNodeId(node.id);
    setNodeName(String(node.name || ""));
    setNodeLink(String(node.sourceLink || ""));
    setNodeAutoGroup(normalizeProxyNodeAutoGroup(node.autoGroup));
    setNodeDialogOpen(true);
  };

  const submitNode = () => {
    const name = nodeName.trim();
    const link = nodeLink.trim();
    if (!name) {
      toast.error("请填写节点名称");
      return;
    }
    if (!link) {
      toast.error("请粘贴落地机的节点链接");
      return;
    }
    if (editingNodeId) updateNode.mutate({ id: editingNodeId, name, link, autoGroup: nodeAutoGroup });
    else createNode.mutate({ name, link, autoGroup: nodeAutoGroup });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">客户端订阅</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            转发规则只记录地址和端口，不含节点凭据。把落地机的节点链接在这里登记一次，
            面板会把每条绑定的转发改写成可导入的节点，之后新增转发会自动进订阅。
          </p>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Server className="h-4 w-4" />
                落地节点
              </CardTitle>
              <CardDescription>
                按落地机登记，不是按转发。多条转发指向同一台落地机时共用一个节点即可，
                面板会为它们额外生成一个自动选路组。
              </CardDescription>
            </div>
            <Button size="sm" onClick={openCreateNode}>
              <Plus className="mr-1 h-4 w-4" />
              添加节点
            </Button>
          </CardHeader>
          <CardContent>
            {nodesQuery.isLoading ? (
              <DataSectionLoading />
            ) : nodes.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                还没有登记节点。先从落地机复制一条 VLESS / VMess / Trojan / Shadowsocks 链接粘进来。
              </p>
            ) : (
              <div className="space-y-2">
                {nodes.map((node: any) => (
                  <div
                    key={node.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{node.name}</span>
                        <Badge variant="secondary">
                          {PROXY_NODE_PROTOCOL_LABELS[node.protocol as ProxyNodeProtocol] || node.protocol}
                        </Badge>
                        {!node.isEnabled && <Badge variant="outline">已停用</Badge>}
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {node.address}:{node.port}
                        {node.ruleCount > 0 ? ` · ${node.ruleCount} 条转发在用` : " · 暂无转发绑定"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select
                        value={normalizeProxyNodeAutoGroup(node.autoGroup)}
                        onValueChange={(value) => updateNode.mutate({
                          id: node.id,
                          autoGroup: value as ProxyNodeAutoGroup,
                        })}
                      >
                        <SelectTrigger className="w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PROXY_NODE_AUTO_GROUPS.map((mode) => (
                            <SelectItem key={mode} value={mode}>
                              {PROXY_NODE_AUTO_GROUP_LABELS[mode]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Switch
                        checked={!!node.isEnabled}
                        onCheckedChange={(checked) => updateNode.mutate({ id: node.id, isEnabled: checked })}
                      />
                      <Button size="sm" variant="outline" onClick={() => openEditNode(node)}>
                        编辑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          const ok = await confirm({
                            title: "删除这个客户端节点？",
                            description: node.ruleCount > 0
                              ? `${node.ruleCount} 条转发会被解绑，不再出现在订阅里。转发本身继续运行，不受影响。`
                              : "该节点没有被任何转发绑定。",
                            confirmText: "删除",
                          });
                          if (ok) deleteNode.mutate({ id: node.id });
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">订阅内容</CardTitle>
            <CardDescription>
              客户端拉到的就是这份列表。关掉开关可以让某个节点不出现在订阅里，转发本身照常运行。
            </CardDescription>
          </CardHeader>
          <CardContent>
            {previewQuery.isLoading ? (
              <DataSectionLoading />
            ) : (
              <div className="space-y-4">
                {(preview?.nodes.length ?? 0) === 0 ? (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    订阅里还没有节点。先添加落地节点，再在下面把转发加进来。
                  </p>
                ) : (
                  <div className="space-y-2">
                    {preview!.nodes.map((node) => (
                      <div
                        key={node.ruleId}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <Eye className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span className="truncate font-medium">{node.name}</span>
                          </div>
                          <p className="mt-1 truncate text-xs text-muted-foreground">
                            {node.address}:{node.port}
                          </p>
                        </div>
                        <Switch
                          checked
                          onCheckedChange={() => setRuleVisible.mutate({ ruleId: node.ruleId, visible: false })}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {hiddenRules.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">已隐藏（不在订阅里）</p>
                    {hiddenRules.map((item) => (
                      <div
                        key={item.ruleId}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-3"
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <EyeOff className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="truncate text-sm text-muted-foreground">{item.ruleName}</span>
                        </div>
                        <Switch
                          checked={false}
                          onCheckedChange={() => setRuleVisible.mutate({ ruleId: item.ruleId, visible: true })}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {(preview?.groups.length ?? 0) > 0 && (
                  <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
                    <p className="flex items-center gap-1.5 text-xs font-medium">
                      <Zap className="h-3.5 w-3.5" />
                      自动选路组（Clash 与 sing-box 可用）
                    </p>
                    {preview!.groups.map((group) => (
                      <div key={group.name} className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{group.name}</span>
                        {group.type === "url-test" ? " 自动选最快 · " : " 主备切换 · "}
                        {group.members.join(" / ")}
                      </div>
                    ))}
                    <p className="text-xs text-muted-foreground">
                      在客户端里选这个组，它会自己挑最快的中转，那条挂了自动换下一条。
                      通用 Base64 和 Loon 的节点订阅格式表达不了策略组，只会拿到裸节点。
                    </p>
                  </div>
                )}

                {unboundRules.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      还没加入订阅的转发（选一个落地节点即可加入）
                    </p>
                    {unboundRules.map((item) => (
                      <div
                        key={item.ruleId}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-3"
                      >
                        <span className="min-w-0 flex-1 truncate text-sm">{item.ruleName}</span>
                        <Select
                          value=""
                          disabled={enabledNodes.length === 0}
                          onValueChange={(value) => bindRule.mutate({
                            ruleId: item.ruleId,
                            proxyNodeId: Number(value),
                          })}
                        >
                          <SelectTrigger className="w-48">
                            <SelectValue
                              placeholder={enabledNodes.length === 0 ? "请先添加落地节点" : "选择落地节点"}
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {enabledNodes.map((node: any) => (
                              <SelectItem key={node.id} value={String(node.id)}>
                                {node.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                )}

                {otherSkipped.length > 0 && (
                  <div className="rounded-lg bg-muted/50 p-3">
                    <p className="text-xs font-medium text-muted-foreground">未进入订阅的转发</p>
                    <ul className="mt-2 space-y-1">
                      {otherSkipped.map((item) => (
                        <li key={item.ruleId} className="text-xs text-muted-foreground">
                          {item.ruleName} —— {item.label}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Link2 className="h-4 w-4" />
                订阅链接
              </CardTitle>
              <CardDescription>
                地址里带着全部节点凭据，谁拿到谁就能用你的节点。建议一台设备一个链接，丢了只重置那一个。
              </CardDescription>
            </div>
            <Button
              size="sm"
              onClick={() => {
                setTokenName("");
                setTokenFormat("base64");
                setTokenDialogOpen(true);
              }}
            >
              <Plus className="mr-1 h-4 w-4" />
              新建链接
            </Button>
          </CardHeader>
          <CardContent>
            {tokensQuery.isLoading ? (
              <DataSectionLoading />
            ) : tokens.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                还没有订阅链接。新建一个，然后把地址导入客户端。
              </p>
            ) : (
              <div className="space-y-4">
                {tokens.map((token: any) => (
                  <div key={token.id} className="space-y-3 rounded-lg border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{token.name}</span>
                        {!token.isEnabled && <Badge variant="outline">已停用</Badge>}
                        <span className="text-xs text-muted-foreground">
                          已拉取 {token.accessCount || 0} 次
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={!!token.isEnabled}
                          onCheckedChange={(checked) => updateToken.mutate({ id: token.id, isEnabled: checked })}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            const ok = await confirm({
                              title: "重置这个订阅地址？",
                              description: "旧地址立即失效，已经导入过的客户端需要重新填写新地址。",
                              confirmText: "重置",
                            });
                            if (ok) rotateToken.mutate({ id: token.id });
                          }}
                        >
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            const ok = await confirm({
                              title: "删除这个订阅链接？",
                              description: "使用该地址的客户端将立即无法更新节点。",
                              confirmText: "删除",
                            });
                            if (ok) deleteToken.mutate({ id: token.id });
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    <div className="grid gap-2">
                      {PROXY_SUBSCRIPTION_FORMATS.map((format) => (
                        <div key={format} className="flex items-center gap-2">
                          <span className="w-28 shrink-0 text-xs text-muted-foreground">
                            {PROXY_SUBSCRIPTION_FORMAT_LABELS[format]}
                          </span>
                          <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
                            {subscriptionUrl(token.token, format)}
                          </code>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => copyText(
                              subscriptionUrl(token.token, format),
                              `${PROXY_SUBSCRIPTION_FORMAT_LABELS[format]} 地址已复制`,
                            )}
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={nodeDialogOpen} onOpenChange={setNodeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingNodeId ? "编辑客户端节点" : "添加客户端节点"}</DialogTitle>
            <DialogDescription>
              粘贴落地机上的原始节点链接。面板只会把地址和端口换成转发入口，
              UUID、密码、SNI、传输方式等全部原样保留。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="proxy-node-name">节点名称</Label>
              <Input
                id="proxy-node-name"
                value={nodeName}
                onChange={(event) => setNodeName(event.target.value)}
                placeholder="例如 HKT 落地"
              />
            </div>
            <div className="space-y-2">
              <Label>多中转时的选路方式</Label>
              <Select
                value={nodeAutoGroup}
                onValueChange={(value) => setNodeAutoGroup(value as ProxyNodeAutoGroup)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROXY_NODE_AUTO_GROUPS.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {PROXY_NODE_AUTO_GROUP_LABELS[mode]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{PROXY_NODE_AUTO_GROUP_HINTS[nodeAutoGroup]}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="proxy-node-link">节点链接</Label>
              <Textarea
                id="proxy-node-link"
                value={nodeLink}
                onChange={(event) => setNodeLink(event.target.value)}
                placeholder="vless://... 或 vmess:// / trojan:// / ss://"
                rows={4}
                className="font-mono text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNodeDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={submitNode} disabled={createNode.isPending || updateNode.isPending}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={tokenDialogOpen} onOpenChange={setTokenDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建订阅链接</DialogTitle>
            <DialogDescription>
              默认格式用于客户端没有表明身份时的回落；Clash、sing-box、Loon 通常能被自动识别。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="proxy-token-name">用途</Label>
              <Input
                id="proxy-token-name"
                value={tokenName}
                onChange={(event) => setTokenName(event.target.value)}
                placeholder="例如 我的手机"
              />
            </div>
            <div className="space-y-2">
              <Label>默认格式</Label>
              <Select
                value={tokenFormat}
                onValueChange={(value) => setTokenFormat(value as ProxySubscriptionFormat)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROXY_SUBSCRIPTION_FORMATS.map((format) => (
                    <SelectItem key={format} value={format}>
                      {PROXY_SUBSCRIPTION_FORMAT_LABELS[format]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {PROXY_SUBSCRIPTION_FORMAT_HINTS[tokenFormat]}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTokenDialogOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => {
                const name = tokenName.trim();
                if (!name) {
                  toast.error("请填写用途，方便以后分清是哪台设备");
                  return;
                }
                createToken.mutate({ name, defaultFormat: tokenFormat });
              }}
              disabled={createToken.isPending}
            >
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
