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
import { copyTextToClipboard } from "@/lib/clipboard";
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
import {
  PROXY_RULE_PRESETS,
  PROXY_RULE_PRESET_HINTS,
  PROXY_RULE_PRESET_LABELS,
  normalizeProxyRulePreset,
  type ProxyRulePreset,
} from "@shared/proxyRuleset";
import {
  buildProxySubscriptionUrl,
  detectProxyClientPlatform,
  proxyClientPlatformsLabel,
  PROXY_CLIENT_PLATFORM_LABELS,
  PROXY_CLIENT_TARGETS,
  proxySubscriptionKindSupported,
  PROXY_SUBSCRIPTION_KINDS,
  PROXY_SUBSCRIPTION_KIND_HINTS,
  PROXY_SUBSCRIPTION_KIND_LABELS,
  type ProxyClientPlatform,
  type ProxyClientTarget,
  type ProxySubscriptionKind,
} from "@shared/proxyClientImport";
import {
  Atom,
  AudioLines,
  Cat,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Layers,
  Link2,
  Package,
  Plus,
  QrCode,
  Rocket,
  Server,
  Shield,
  Boxes,
  Ship,
  Binary,
  Blocks,
  Trash2,
  Waves,
  Zap,
  type LucideIcon,
} from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

/**
 * 每个客户端一个可辨识的图案 + 各自的品牌色。
 *
 * 刻意不用各家的官方 logo：那些是第三方商标资源，不该擅自打包进仓库，而且面板的
 * CSP 也不允许从外部 CDN 拉图片（不少面板还跑在内网）。七格清一色同一个下载图标
 * 等于没有图标 —— 用户还是得逐字读标签，网格就白排了。
 */
const CLIENT_ICONS: Record<string, { icon: LucideIcon; className: string }> = {
  // mihomo 的吉祥物就是只猫。
  clash: { icon: Cat, className: "bg-sky-500/10 text-sky-600 dark:text-sky-400" },
  stash: { icon: Layers, className: "bg-violet-500/10 text-violet-600 dark:text-violet-400" },
  singbox: { icon: Package, className: "bg-orange-500/10 text-orange-600 dark:text-orange-400" },
  loon: { icon: Waves, className: "bg-teal-500/10 text-teal-600 dark:text-teal-400" },
  surge: { icon: AudioLines, className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  quantumultx: { icon: Atom, className: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400" },
  hiddify: { icon: Shield, className: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  shadowrocket: { icon: Rocket, className: "bg-rose-500/10 text-rose-600 dark:text-rose-400" },
  v2rayng: { icon: Binary, className: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400" },
  surfboard: { icon: Ship, className: "bg-lime-500/10 text-lime-600 dark:text-lime-400" },
  nekobox: { icon: Boxes, className: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  nekoray: { icon: Blocks, className: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400" },
  v2rayn: { icon: Binary, className: "bg-slate-500/10 text-slate-600 dark:text-slate-400" },
};

function clientIcon(target: ProxyClientTarget) {
  return CLIENT_ICONS[target.id] ?? { icon: Package, className: "bg-muted text-muted-foreground" };
}

/**
 * 可选的官方图标：把图片丢进 assets/clientLogos/<客户端 id>.svg|png|webp 就会自动用上。
 *
 * 构建期扫描而不是运行期探测：没放图标的面板不会为此发一串 404 请求，放了的
 * 也走正常打包，不受 CSP 限制（面板常跑在内网，外部 CDN 一律拉不到）。
 * 仓库里不预置这些图 —— 闭源客户端的图标是各自开发者的商标资源，
 * 而这个面板是公开分发的。详见该目录下的 README。
 */
const CLIENT_LOGOS: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob("../assets/clientLogos/*.{svg,png,webp}", {
      eager: true,
      import: "default",
    }) as Record<string, string>,
  ).map(([path, url]) => [path.replace(/^.*\/(.+)\.\w+$/, "$1"), url]),
);

/** 当前设备。识别不出来时返回 null —— 那就退回展示全部，别把人挡在外面。 */
function currentPlatform(): ProxyClientPlatform | null {
  if (typeof navigator === "undefined") return null;
  return detectProxyClientPlatform(navigator.userAgent, {
    maxTouchPoints: navigator.maxTouchPoints,
  });
}

function subscriptionUrl(
  token: string,
  format: ProxySubscriptionFormat,
  kind: ProxySubscriptionKind,
  pinFormat = false,
) {
  return buildProxySubscriptionUrl({ origin: window.location.origin, token, format, kind, pinFormat });
}

async function copyText(value: string, message: string) {
  // 面板常跑在 http://ip:port 上，非安全上下文里 navigator.clipboard 根本不存在，
  // 所以走带 execCommand 回退的共享实现，而不是直接调 clipboard API。
  if (await copyTextToClipboard(value)) {
    toast.success(message);
  } else {
    toast.error("复制失败，请长按选中地址复制");
  }
}

export default function ClientSubscriptionsPage() {
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();

  const permissionQuery = trpc.proxySubscriptions.permission.useQuery();
  const allowed = permissionQuery.data?.allowed ?? true;

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
  const [tokenRulePreset, setTokenRulePreset] = useState<ProxyRulePreset>("balanced");
  // 一键订阅面板默认折叠，同一时间只展开一个，免得页面被撑得很长。
  const [importOpenTokenId, setImportOpenTokenId] = useState<number | null>(null);
  const [importKind, setImportKind] = useState<ProxySubscriptionKind>("nodes");
  const [qrTarget, setQrTarget] = useState<{ title: string; url: string; hint?: string } | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [showAllClients, setShowAllClients] = useState(false);
  // 只认一次：UA 在页面生命周期里不会变。
  const platform = useMemo(() => currentPlatform(), []);
  const visibleTargets = useMemo(() => {
    if (!platform || showAllClients) return [...PROXY_CLIENT_TARGETS];
    return PROXY_CLIENT_TARGETS.filter((target) => target.platforms.includes(platform));
  }, [platform, showAllClients]);
  const hiddenCount = PROXY_CLIENT_TARGETS.length - visibleTargets.length;

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

  // 二维码固定黑白：跟着主题走的话，深色模式下扫不出来。
  useEffect(() => {
    if (!qrTarget) {
      setQrDataUrl("");
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(qrTarget.url, { width: 480, margin: 1, color: { dark: "#000000", light: "#ffffff" } })
      .then((value) => {
        if (!cancelled) setQrDataUrl(value);
      })
      .catch(() => {
        if (!cancelled) toast.error("二维码生成失败，复制地址手动添加即可");
      });
    return () => {
      cancelled = true;
    };
  }, [qrTarget]);

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

  // 权限查询未回来时先不下结论，避免闪一下「无权限」再闪回正常。
  if (permissionQuery.isLoading) {
    return (
      <DashboardLayout>
        <DataSectionLoading />
      </DashboardLayout>
    );
  }

  if (!allowed) {
    return (
      <DashboardLayout>
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold">客户端订阅</h1>
          </div>
          <Card>
            <CardContent className="py-10 text-center">
              <p className="text-sm text-muted-foreground">
                当前账号没有客户端订阅权限。
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                该权限由管理员单独授予，或包含在部分套餐中。转发被停用或流量用尽时也会暂时收回。
              </p>
            </CardContent>
          </Card>
        </div>
      </DashboardLayout>
    );
  }

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
                每个链接都给出两种地址：节点订阅只有节点，规则订阅连分流一起给。
                地址里带着全部节点凭据，建议一台设备一个链接，丢了只重置那一条。
              </CardDescription>
            </div>
            <Button
              size="sm"
              onClick={() => {
                setTokenName("");
                setTokenFormat("base64");
                setTokenRulePreset("balanced");
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
                {tokens.map((token: any) => {
                  const expanded = importOpenTokenId === token.id;
                  const kind = importKind;
                  const preset = normalizeProxyRulePreset(token.rulePreset);
                  // 手动复制的地址刻意不带 format：让服务端按客户端标识协商，
                  // 这样同一条地址粘到哪个客户端都能拿到对的格式。
                  const manualUrl = subscriptionUrl(token.token, "base64", kind);
                  return (
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
                        {/* 光写"重置"配个刷新图标，在订阅面板里只会被读成"重置流量"。
                            补上宾语并换成钥匙图标：这个按钮的代价是所有已导入的客户端都要重填。 */}
                        <Button
                          size="sm"
                          variant="outline"
                          title="重置订阅地址（不会重置流量）"
                          onClick={async () => {
                            const ok = await confirm({
                              title: "重置这个订阅地址？",
                              description:
                                "只更换订阅地址本身，不会重置流量。旧地址立即失效，已经导入过的客户端都要重新填写新地址。",
                              confirmText: "重置地址",
                            });
                            if (ok) rotateToken.mutate({ id: token.id });
                          }}
                        >
                          <KeyRound className="mr-1 h-4 w-4" />
                          重置地址
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          title="删除订阅链接"
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

                    <Button
                      variant={expanded ? "secondary" : "default"}
                      className="w-full"
                      onClick={() => setImportOpenTokenId(expanded ? null : token.id)}
                    >
                      <Zap className="mr-1.5 h-4 w-4" />
                      一键订阅
                      <ChevronDown
                        className={`ml-1.5 h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`}
                      />
                    </Button>

                    {expanded && (
                      <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
                        <div className="flex rounded-md border bg-background p-0.5">
                          {PROXY_SUBSCRIPTION_KINDS.map((item) => (
                            <button
                              key={item}
                              type="button"
                              onClick={() => setImportKind(item)}
                              className={`flex-1 rounded px-2 py-1.5 text-xs font-medium transition-colors ${
                                kind === item
                                  ? "bg-primary text-primary-foreground"
                                  : "text-muted-foreground hover:text-foreground"
                              }`}
                            >
                              {PROXY_SUBSCRIPTION_KIND_LABELS[item]}
                            </button>
                          ))}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {PROXY_SUBSCRIPTION_KIND_HINTS[kind]}
                        </p>

                        {kind === "rules" && (
                          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background px-2 py-1.5">
                            <span className="text-xs text-muted-foreground">
                              分流规则：{PROXY_RULE_PRESET_LABELS[preset]}
                            </span>
                            <Select
                              value={preset}
                              onValueChange={(value) => updateToken.mutate({
                                id: token.id,
                                rulePreset: value as ProxyRulePreset,
                              })}
                            >
                              <SelectTrigger className="h-7 w-24 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {PROXY_RULE_PRESETS.filter((item) => item !== "off").map((item) => (
                                  <SelectItem key={item} value={item}>
                                    {PROXY_RULE_PRESET_LABELS[item]}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}

                        {/* 一键导入走 deep link，只有装了该客户端的设备点得动 ——
                            在 Windows 上摆一格 loon:// 就是个死按钮。所以按当前设备筛，
                            但留一个口子：识别错了或者想看别的平台，点开就是。 */}
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                          {visibleTargets.map((target) => {
                            const supported = proxySubscriptionKindSupported(target.format, kind);
                            // 从客户端图标点进去时已经知道是哪个客户端了，钉死格式，
                            // 不让它掉到令牌默认格式上。
                            const url = subscriptionUrl(token.token, target.format, kind, true);
                            const importName = `${token.name} · ${PROXY_SUBSCRIPTION_KIND_LABELS[kind]}`;
                            const { icon: Icon, className: iconClass } = clientIcon(target);
                            const logo = CLIENT_LOGOS[target.id];
                            const offPlatform = platform ? !target.platforms.includes(platform) : false;
                            const usable = supported && !offPlatform;
                            const tile = (
                              <>
                                <span
                                  className={`flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg ${
                                    logo ? "bg-transparent" : usable ? iconClass : "bg-muted text-muted-foreground"
                                  }`}
                                >
                                  {logo ? (
                                    // 置灰的格子连图标一起褪色，否则一格彩色 logo 配一行"本机没有"很矛盾。
                                    <img
                                      src={logo}
                                      alt=""
                                      className={`h-full w-full object-contain ${usable ? "" : "opacity-50 grayscale"}`}
                                    />
                                  ) : (
                                    <Icon className="h-4 w-4" />
                                  )}
                                </span>
                                <span className="w-full truncate text-center text-[11px] font-medium leading-tight">
                                  {target.shortLabel}
                                </span>
                                <span className="w-full truncate text-center text-[10px] text-muted-foreground">
                                  {!supported
                                    ? "不支持规则"
                                    : offPlatform
                                      ? "本机没有"
                                      : target.buildImportUrl
                                        ? proxyClientPlatformsLabel(target)
                                        : "手动添加"}
                                </span>
                              </>
                            );
                            const tileClass =
                              "flex flex-col items-center gap-1.5 rounded-lg border bg-background p-2.5 text-inherit transition-colors hover:border-primary hover:bg-primary/5";
                            const covers = target.covers ? `。同样适用于：${target.covers}` : "";

                            // 不支持时置灰而不是隐藏：藏起来用户不知道为什么少了几个客户端。
                            if (usable && !target.buildImportUrl) {
                              // 没有官方 scheme 的客户端：点开给它对应格式的地址和二维码，
                              // 外加一句粘到哪儿 —— 订阅地址本身对任何客户端都有效，
                              // 少的只是自动跳转那一步，不是不支持。
                              return (
                                <button
                                  key={target.id}
                                  type="button"
                                  title={`${target.label} 没有一键导入，点开取地址手动添加${covers}`}
                                  onClick={() =>
                                    setQrTarget({
                                      title: `${target.label} · ${PROXY_SUBSCRIPTION_KIND_LABELS[kind]}`,
                                      url,
                                      hint: target.manualHint,
                                    })
                                  }
                                  className={tileClass}
                                >
                                  {tile}
                                </button>
                              );
                            }

                            return usable ? (
                              <a
                                key={target.id}
                                href={target.buildImportUrl!(url, importName)}
                                title={`在 ${target.label} 中打开${covers}`}
                                className={tileClass}
                              >
                                {tile}
                              </a>
                            ) : (
                              <div
                                key={target.id}
                                title={
                                  !supported
                                    ? `${target.label} 的订阅是节点列表，表达不了分流规则；改用「节点订阅」即可。`
                                    : `${target.label} 不支持${platform ? PROXY_CLIENT_PLATFORM_LABELS[platform] : "当前系统"}，在这台设备上点了不会有反应。`
                                }
                                className="flex cursor-not-allowed flex-col items-center gap-1.5 rounded-lg border border-dashed bg-background/50 p-2.5 opacity-60"
                              >
                                {tile}
                              </div>
                            );
                          })}
                        </div>

                        {platform && hiddenCount > 0 && (
                          <button
                            type="button"
                            onClick={() => setShowAllClients((value) => !value)}
                            className="w-full text-center text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                          >
                            {showAllClients
                              ? `只看 ${PROXY_CLIENT_PLATFORM_LABELS[platform]} 能用的`
                              : `还有 ${hiddenCount} 个别的平台的客户端，显示全部`}
                          </button>
                        )}

                        {/* 手机上一行放不下「地址 + 两个按钮」，挤到地址只剩几个字符，
                            所以窄屏竖排、宽屏再并成一行。 */}
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1.5 text-xs">
                            {manualUrl}
                          </code>
                          <div className="flex shrink-0 items-center gap-2">
                            {/* 上面的图标只在「面板和客户端同一台设备」时有用；
                                在电脑上看面板、往手机里导入，走的是这个二维码。 */}
                            <Button
                              size="sm"
                              variant="outline"
                              className="flex-1 sm:flex-none"
                              onClick={() =>
                                setQrTarget({
                                  title: `${token.name} · ${PROXY_SUBSCRIPTION_KIND_LABELS[kind]}`,
                                  url: manualUrl,
                                })
                              }
                            >
                              <QrCode className="mr-1 h-3.5 w-3.5" />
                              扫码
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="flex-1 sm:flex-none"
                              onClick={() => copyText(manualUrl, "订阅地址已复制")}
                            >
                              <Copy className="mr-1 h-3.5 w-3.5" />
                              复制
                            </Button>
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          客户端不在上面，或者面板开在电脑上？扫码或复制这条地址手动添加即可，服务端会按客户端标识自动返回对应格式。
                        </p>
                      </div>
                    )}
                  </div>
                  );
                })}
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
            <div className="space-y-2">
              <Label>规则订阅使用的分流预设</Label>
              <Select
                value={tokenRulePreset}
                onValueChange={(value) => setTokenRulePreset(value as ProxyRulePreset)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROXY_RULE_PRESETS.filter((preset) => preset !== "off").map((preset) => (
                    <SelectItem key={preset} value={preset}>
                      {PROXY_RULE_PRESET_LABELS[preset]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{PROXY_RULE_PRESET_HINTS[tokenRulePreset]}</p>
              <p className="text-xs text-muted-foreground">
                每个订阅链接都会同时给出「节点订阅」和「规则订阅」两个地址，这里选的是后者用哪档。
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
                createToken.mutate({ name, defaultFormat: tokenFormat, rulePreset: tokenRulePreset });
              }}
              disabled={createToken.isPending}
            >
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!qrTarget} onOpenChange={(open) => !open && setQrTarget(null)}>
        {/* DialogContent 是 grid，子项默认 min-width:auto —— 底下那条不可断行的长地址
            会把整列撑宽再被 overflow-hidden 切掉，所以这里逐层 min-w-0，地址本身也断行。 */}
        <DialogContent className="sm:max-w-sm">
          <DialogHeader className="min-w-0 pr-8">
            <DialogTitle className="flex items-center gap-2">
              <QrCode className="h-4 w-4 shrink-0" />
              扫码导入
            </DialogTitle>
            <DialogDescription className="truncate">{qrTarget?.title}</DialogDescription>
          </DialogHeader>

          <div className="min-w-0 space-y-3">
            <div className="flex justify-center">
              {qrDataUrl ? (
                // 白底不能省：二维码本身是透明背景的黑块，深色主题下会糊成一片。
                // 宽度跟着对话框走，窄屏上整体缩小而不是被裁掉一半。
                <div className="w-full max-w-[264px] rounded-lg bg-white p-3">
                  <img src={qrDataUrl} alt="订阅二维码" className="block h-auto w-full" />
                </div>
              ) : (
                <div className="flex aspect-square w-full max-w-[264px] items-center justify-center rounded-lg border text-sm text-muted-foreground">
                  二维码生成中…
                </div>
              )}
            </div>

            {qrTarget?.hint ? (
              <p className="rounded-md border border-dashed bg-muted/40 px-2 py-1.5 text-xs leading-relaxed">
                <span className="font-medium">粘到这里：</span>
                {qrTarget.hint}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                请在客户端的「添加订阅」里扫码。用系统相机扫只会在浏览器里打开这条地址，得到的是一屏乱码。
              </p>
            )}

            {/* 手机上截断的地址等于没有：复制失败时连手动选中都做不到，所以整条断行显示。 */}
            <code className="block break-all rounded bg-muted px-2 py-1.5 text-xs leading-relaxed">
              {qrTarget?.url}
            </code>
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={() => qrTarget && copyText(qrTarget.url, "订阅地址已复制")}
            >
              <Copy className="mr-1 h-3.5 w-3.5" />
              复制地址
            </Button>

            <p className="text-xs text-muted-foreground">
              这张码等于一份完整的节点凭据，别截图发到群里。
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
