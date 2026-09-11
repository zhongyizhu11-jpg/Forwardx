import DashboardLayout from "@/components/DashboardLayout";
import ProxyInboundsSection from "@/components/proxy/ProxyInboundsSection";
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
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import {
  PROXY_NODE_PROTOCOL_LABELS,
  type ProxyNodeProtocol,
} from "@shared/proxyNode";
import {
  normalizeProxySubscriptionFormat,
  PROXY_SUBSCRIPTION_FORMATS,
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
import { type ProxyNodeHealth } from "@shared/proxyNodeHealth";
import {
  formatProxyNodeQuotaDetail,
  hasProxyNodeQuota,
  proxyNodeQuotaState,
} from "@shared/proxyNodeQuota";
import {
  groupProxyNodes,
  normalizeProxyNodeGroupMode,
  PROXY_NODE_GROUP_MODES,
  PROXY_NODE_GROUP_MODE_LABELS,
  type ProxyNodeGroupMode,
} from "@shared/proxyNodeGrouping";
import {
  Atom,
  AudioLines,
  Cat,
  ChevronDown,
  Copy,
  Eye,
  Gauge,
  EyeOff,
  KeyRound,
  Layers,
  Link2,
  Package,
  Pencil,
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
    import.meta.glob("../assets/clientLogos/*.{svg,png,webp,jpg,jpeg,ico}", {
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

const NODE_GROUP_MODE_STORAGE_KEY = "forwardx.proxyNodes.groupMode";
const NODE_COLLAPSED_STORAGE_KEY = "forwardx.proxyNodes.collapsed";

function readStoredGroupMode(): ProxyNodeGroupMode {
  if (typeof window === "undefined") return "none";
  try {
    return normalizeProxyNodeGroupMode(window.localStorage.getItem(NODE_GROUP_MODE_STORAGE_KEY));
  } catch {
    return "none";
  }
}

/** 折叠起来的分组键。存不上也不影响用，只是下次进来又是展开的。 */
function readStoredCollapsed(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(NODE_COLLAPSED_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeStored(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 隐私模式下写不进去，忽略即可 —— 这只是个记住偏好的便利。
  }
}

const NODE_HEALTH_STYLES: Record<ProxyNodeHealth["state"], string> = {
  online: "bg-emerald-500",
  offline: "bg-red-500",
  // 灰色而不是红色：没人在探它不等于它挂了，标红会把好节点冤枉成故障。
  unknown: "bg-muted-foreground/40",
};

/**
 * 落地节点的在线小圆点。
 *
 * 探测是中转机发出的 tcping，所以这里回答的是「中转连不连得上这个落地」，
 * 不是「你的客户端连不连得上」—— 悬停说明里写明了，免得红点被当成落地挂了
 * 而其实只是中转到落地那一段不通。
 */
function ProxyNodeHealthDot({ health }: { health?: ProxyNodeHealth | null }) {
  const state = health?.state || "unknown";
  const detail = health?.title || "暂无探测结果";
  const label = state === "online" ? "在线" : state === "offline" ? "离线" : "未知";
  return (
    <span
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${NODE_HEALTH_STYLES[state]}`}
      title={`${label} · ${detail}（由中转机探测，不代表你的客户端能连上）`}
      aria-label={`${label}：${detail}`}
    />
  );
}

/**
 * GB ↔ 字节。用 1000 而不是 1024：机房卖的「1000G」是按 1000 算的，
 * 按 1024 存进去再显示出来会变成 931G，跟你填的数对不上。
 */
const GB_IN_BYTES = 1e9;

function bytesFromGb(value: string): number {
  const gb = Number(String(value).trim());
  if (!Number.isFinite(gb) || gb <= 0) return 0;
  return Math.round(gb * GB_IN_BYTES);
}

function gbFromBytes(bytes: unknown): string {
  const value = Number(bytes) || 0;
  if (value <= 0) return "";
  const gb = value / GB_IN_BYTES;
  return String(gb >= 100 ? Math.round(gb) : Number(gb.toFixed(2)));
}

/**
 * 订阅内容的两类条目。
 *
 * 中转在前：那是主力 —— 直连条目只有开了「加进订阅」的节点才有，通常只有一两条，
 * 而且落地 IP 直接暴露在订阅里，放后面不容易被误当成常规入口。
 */
const PREVIEW_GROUPS = [
  { key: "relay", label: "中转" },
  { key: "direct", label: "直连" },
] as const;

const QUOTA_STATE_STYLES = {
  none: "text-muted-foreground",
  normal: "text-muted-foreground",
  warn: "text-amber-600 dark:text-amber-500",
  exceeded: "text-red-600 dark:text-red-500",
} as const;

function nodeQuotaOf(node: any) {
  return {
    bandwidthMbps: Number(node.bandwidthMbps || 0),
    trafficLimit: Number(node.trafficLimit || 0),
    trafficUsed: Number(node.trafficUsed || 0),
  };
}

/**
 * 套餐用量的开关：一个小图标，点一下才展开。
 *
 * 常驻显示试过两版都不行 —— 放第一行会把节点名挤没，放第二行会把 IP 端口截断。
 * 手机上那一行就这么宽，地址和套餐只能二选一常驻，而地址是每次都要看的那个。
 *
 * 但图标本身带颜色：用到 80% 变黄、超额变红。不然把数字藏起来的代价就是
 * 「快超额了却要逐个点开才发现」，那比挤掉地址更糟。
 */
function ProxyNodeQuotaToggle({ node, expanded, onToggle }: { node: any; expanded: boolean; onToggle: () => void }) {
  const quota = nodeQuotaOf(node);
  if (!hasProxyNodeQuota(quota)) return null;
  const state = proxyNodeQuotaState(quota);
  return (
    <button
      type="button"
      className={`shrink-0 rounded p-1 transition-colors hover:bg-muted ${QUOTA_STATE_STYLES[state]}`}
      onClick={onToggle}
      aria-expanded={expanded}
      // 桌面端悬停就能看到，不必点开；手机上没有悬停，所以图标本身要能点。
      title={`${formatProxyNodeQuotaDetail(quota)}${state === "exceeded" ? "（已超出总流量）" : state === "warn" ? "（接近总流量）" : ""}`}
    >
      <Gauge className="h-3.5 w-3.5" />
    </button>
  );
}

/**
 * 展开后的那一行。带标签写清三个数各自是什么 —— 折起来时的 `500M/1T/367G`
 * 得先知道顺序才读得懂，展开了就没必要让人猜。
 */
function ProxyNodeQuotaDetail({ node }: { node: any }) {
  const quota = nodeQuotaOf(node);
  const state = proxyNodeQuotaState(quota);
  return (
    <p className={`truncate text-[11px] leading-tight ${QUOTA_STATE_STYLES[state]}`}>
      {formatProxyNodeQuotaDetail(quota)}
    </p>
  );
}

export default function ClientSubscriptionsPage() {
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();

  const permissionQuery = trpc.proxySubscriptions.permission.useQuery();
  const allowed = permissionQuery.data?.allowed ?? true;

  /**
   * 轮询而不是只在进页面时取一次：在线状态与流量是会变的，不刷新的话那个小圆点
   * 会一直停在你进页面那一刻的颜色 —— 一个不动的状态灯比没有状态灯更误导。
   * 探测的新鲜期是 6 分钟，30 秒一次足够跟上，也不至于把面板打满。
   */
  const nodesQuery = trpc.proxySubscriptions.listNodes.useQuery(undefined, {
    refetchInterval: pollingInterval("slow"),
    refetchOnWindowFocus: true,
  });
  const tokensQuery = trpc.proxySubscriptions.listTokens.useQuery();
  const previewQuery = trpc.proxySubscriptions.preview.useQuery();

  const [nodeGroupMode, setNodeGroupMode] = useState<ProxyNodeGroupMode>(readStoredGroupMode);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(readStoredCollapsed);
  const [nodesCollapsed, setNodesCollapsed] = useState(false);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  /** 展开了套餐详情的节点。只在本次会话里记着 —— 这是个随手看一眼的动作，不值得持久化。 */
  const [expandedQuotaIds, setExpandedQuotaIds] = useState<number[]>([]);

  const [nodeDialogOpen, setNodeDialogOpen] = useState(false);
  const [editingNodeId, setEditingNodeId] = useState<number | null>(null);
  const [nodeName, setNodeName] = useState("");
  const [nodeLink, setNodeLink] = useState("");
  const [nodeAutoGroup, setNodeAutoGroup] = useState<ProxyNodeAutoGroup>("url-test");
  // 默认关：开了之后落地 IP 会出现在每一条订阅地址里。
  const [nodeIncludeDirect, setNodeIncludeDirect] = useState(false);
  // 0 表示不经由任何前置。
  const [nodeFrontProxyId, setNodeFrontProxyId] = useState(0);
  /** 落地机的套餐规格。带宽用 Mbps，总流量用 GB —— 机房就是按这两个单位卖的。 */
  const [nodeBandwidthMbps, setNodeBandwidthMbps] = useState("");
  const [nodeTrafficLimitGb, setNodeTrafficLimitGb] = useState("");
  const [nodeTrafficUsedGb, setNodeTrafficUsedGb] = useState("");
  const [nodeTrafficAutoReset, setNodeTrafficAutoReset] = useState(false);
  const [nodeTrafficResetDay, setNodeTrafficResetDay] = useState("1");
  // 订阅内容里改名：转发派生的条目改规则上的显示名，直连条目改模板名。
  const [renaming, setRenaming] = useState<
    { kind: "relay" | "direct"; ruleId: number; templateId: number; name: string } | null
  >(null);
  const [renameValue, setRenameValue] = useState("");
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [tokenName, setTokenName] = useState("");
  // 一键订阅面板默认折叠，同一时间只展开一个，免得页面被撑得很长。
  const [importOpenTokenId, setImportOpenTokenId] = useState<number | null>(null);
  const [importKind, setImportKind] = useState<ProxySubscriptionKind>("nodes");
  const [qrTarget, setQrTarget] = useState<{ title: string; url: string; hint?: string } | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [showAllClients, setShowAllClients] = useState(false);
  // 服务器数据目录里放的图标。放了就盖掉内置图案，没放（多数情况）就是个空对象。
  const [runtimeLogos, setRuntimeLogos] = useState<Record<string, string>>({});
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
  const setRuleNodeName = trpc.proxySubscriptions.setRuleNodeName.useMutation({
    onSuccess: () => {
      toast.success("节点名已更新");
      setRenaming(null);
      refresh();
    },
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

  useEffect(() => {
    let cancelled = false;
    fetch("/api/client-logos")
      .then((res) => (res.ok ? res.json() : {}))
      .then((data) => {
        if (!cancelled && data && typeof data === "object") {
          setRuntimeLogos(data as Record<string, string>);
        }
      })
      // 拿不到就用内置图案，不值得为此打扰用户。
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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

  /**
   * 只有一个节点时一律不分组：分组下拉这时是藏起来的，若还按上次选的方式分，
   * 就会出现一个改不掉的分组标题。
   */
  const effectiveGroupMode: ProxyNodeGroupMode = nodes.length > 1 ? nodeGroupMode : "none";
  const nodeGroups = useMemo(
    () => groupProxyNodes(nodes as any[], effectiveGroupMode),
    [nodes, effectiveGroupMode],
  );
  const onlineNodeCount = useMemo(
    () => (nodes as any[]).filter((node) => node?.health?.state === "online").length,
    [nodes],
  );
  const offlineNodeCount = useMemo(
    () => (nodes as any[]).filter((node) => node?.health?.state === "offline").length,
    [nodes],
  );

  const toggleQuota = (id: number) => {
    setExpandedQuotaIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const isGroupCollapsed = (key: string) => collapsedGroups.includes(key);
  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key];
      writeStored(NODE_COLLAPSED_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };
  const changeGroupMode = (mode: ProxyNodeGroupMode) => {
    setNodeGroupMode(mode);
    writeStored(NODE_GROUP_MODE_STORAGE_KEY, mode);
  };
  const preview = previewQuery.data;

  const previewNodes = (preview?.nodes ?? []) as any[];
  const directPreviewNodes = useMemo(
    () => previewNodes.filter((node) => node?.kind === "direct"),
    [previewNodes],
  );
  const relayPreviewNodes = useMemo(
    () => previewNodes.filter((node) => node?.kind !== "direct"),
    [previewNodes],
  );

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
    setNodeIncludeDirect(false);
    setNodeFrontProxyId(0);
    setNodeBandwidthMbps("");
    setNodeTrafficLimitGb("");
    setNodeTrafficUsedGb("");
    setNodeTrafficAutoReset(false);
    setNodeTrafficResetDay("1");
    setNodeDialogOpen(true);
  };

  const openEditNode = (node: any) => {
    setEditingNodeId(node.id);
    setNodeName(String(node.name || ""));
    setNodeLink(String(node.sourceLink || ""));
    setNodeAutoGroup(normalizeProxyNodeAutoGroup(node.autoGroup));
    setNodeIncludeDirect(!!node.includeDirect);
    setNodeFrontProxyId(Number(node.frontProxyId || 0));
    setNodeBandwidthMbps(Number(node.bandwidthMbps || 0) > 0 ? String(node.bandwidthMbps) : "");
    setNodeTrafficLimitGb(gbFromBytes(node.trafficLimit));
    setNodeTrafficUsedGb(gbFromBytes(node.trafficUsed));
    setNodeTrafficAutoReset(!!node.trafficAutoReset);
    setNodeTrafficResetDay(String(Number(node.trafficResetDay || 1)));
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
    const payload = {
      name,
      link,
      autoGroup: nodeAutoGroup,
      includeDirect: nodeIncludeDirect,
      frontProxyId: nodeFrontProxyId,
      bandwidthMbps: Math.max(0, Math.floor(Number(nodeBandwidthMbps) || 0)),
      trafficLimit: bytesFromGb(nodeTrafficLimitGb),
      trafficAutoReset: nodeTrafficAutoReset,
      trafficResetDay: Math.min(28, Math.max(1, Math.floor(Number(nodeTrafficResetDay) || 1))),
    };
    if (editingNodeId) {
      // 已用量只在编辑时能改：新建时还没有任何用量，给个输入框只会让人以为要填。
      updateNode.mutate({ id: editingNodeId, ...payload, trafficUsed: bytesFromGb(nodeTrafficUsedGb) });
    } else {
      createNode.mutate(payload);
    }
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
            <h1 className="text-2xl font-semibold">订阅管理</h1>
          </div>
          <Card>
            <CardContent className="py-10 text-center">
              <p className="text-sm text-muted-foreground">
                当前账号没有客户端订阅权限。
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                联系管理员开通。
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
        <h1 className="text-2xl font-semibold">订阅管理</h1>

        {/*
          「新建节点」放在最前面：自建落地是这一页的起点 —— 先在自己的机器上开出节点，
          再把别处租来的粘进下面的「落地节点」，两类汇合成订阅内容。
        */}
        <ProxyInboundsSection />

        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
            {/* 整块可折叠：节点多的时候要能一把收起来，好翻到下面的订阅内容。 */}
            <button
              type="button"
              className="flex min-w-0 items-center gap-2 text-left"
              onClick={() => setNodesCollapsed((prev) => !prev)}
              aria-expanded={!nodesCollapsed}
            >
              <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${nodesCollapsed ? "-rotate-90" : ""}`} />
              <Server className="h-4 w-4 shrink-0" />
              <CardTitle className="text-base">落地节点</CardTitle>
              {nodes.length > 0 ? (
                <span className="truncate text-xs text-muted-foreground">
                  {nodes.length} 个
                  {onlineNodeCount > 0 ? ` · ${onlineNodeCount} 在线` : ""}
                  {offlineNodeCount > 0 ? ` · ${offlineNodeCount} 离线` : ""}
                </span>
              ) : null}
            </button>
            <div className="flex shrink-0 items-center gap-2">
              {nodes.length > 1 ? (
                <Select value={nodeGroupMode} onValueChange={(value) => changeGroupMode(value as ProxyNodeGroupMode)}>
                  <SelectTrigger className="h-8 w-24 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROXY_NODE_GROUP_MODES.map((mode) => (
                      <SelectItem key={mode} value={mode}>{PROXY_NODE_GROUP_MODE_LABELS[mode]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              <Button size="sm" onClick={openCreateNode}>
                <Plus className="mr-1 h-4 w-4" />
                添加节点
              </Button>
            </div>
          </CardHeader>
          <CardContent hidden={nodesCollapsed} className="pt-0">
            {nodesQuery.isLoading ? (
              <DataSectionLoading />
            ) : nodes.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                还没有登记节点。先从落地机复制一条节点链接粘进来，VLESS / VMess / Trojan / Shadowsocks / Hysteria2 / TUIC / AnyTLS / Snell 都行。
              </p>
            ) : (
              <div className="space-y-3">
                {nodeGroups.map((group) => {
                  // 不分组时只有一组，没必要给它加个「全部」标题占一行。
                  const showHeader = effectiveGroupMode !== "none";
                  const collapsed = showHeader && isGroupCollapsed(group.key);
                  return (
                    <div key={group.key} className="space-y-1.5">
                      {showHeader ? (
                        <button
                          type="button"
                          className="flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground"
                          onClick={() => toggleGroup(group.key)}
                          aria-expanded={!collapsed}
                        >
                          <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
                          <span>{group.label}</span>
                          <span className="tabular-nums">({group.nodes.length})</span>
                          <span className="h-px flex-1 bg-border" />
                        </button>
                      ) : null}
                      {collapsed ? null : (
                        <div className="space-y-1.5">
                          {group.nodes.map((node: any) => {
                            const quotaExpanded = expandedQuotaIds.includes(Number(node.id));
                            return (
                            <div
                              key={node.id}
                              className="flex items-center gap-2 rounded-md border px-2.5 py-1.5"
                            >
                              <ProxyNodeHealthDot health={node.health} />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="truncate text-sm font-medium leading-tight">{node.name}</span>
                                  <Badge variant="secondary" className="h-4 shrink-0 px-1 text-[10px] font-normal">
                                    {PROXY_NODE_PROTOCOL_LABELS[node.protocol as ProxyNodeProtocol] || node.protocol}
                                  </Badge>
                                  {!node.isEnabled && (
                                    <Badge variant="outline" className="h-4 shrink-0 px-1 text-[10px] font-normal">停用</Badge>
                                  )}
                                </div>
                                <p className="truncate text-[11px] leading-tight text-muted-foreground">
                                  {node.address}:{node.port}
                                  {node.ruleCount > 0 ? ` · ${node.ruleCount} 条转发` : " · 无转发绑定"}
                                </p>
                                {quotaExpanded ? <ProxyNodeQuotaDetail node={node} /> : null}
                              </div>
                              <ProxyNodeQuotaToggle
                                node={node}
                                expanded={quotaExpanded}
                                onToggle={() => toggleQuota(Number(node.id))}
                              />
                              <Switch
                                className="shrink-0 scale-90"
                                checked={!!node.isEnabled}
                                onCheckedChange={(checked) => updateNode.mutate({ id: node.id, isEnabled: checked })}
                              />
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7 shrink-0"
                                title="编辑"
                                onClick={() => openEditNode(node)}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7 shrink-0"
                                title="删除"
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
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
            <button
              type="button"
              className="flex min-w-0 items-center gap-2 text-left"
              onClick={() => setPreviewCollapsed((prev) => !prev)}
              aria-expanded={!previewCollapsed}
            >
              <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${previewCollapsed ? "-rotate-90" : ""}`} />
              <CardTitle className="text-base">订阅内容</CardTitle>
              {(preview?.nodes.length ?? 0) > 0 ? (
                <span className="truncate text-xs text-muted-foreground">
                  {preview!.nodes.length} 条
                  {relayPreviewNodes.length > 0 ? ` · 中转 ${relayPreviewNodes.length}` : ""}
                  {directPreviewNodes.length > 0 ? ` · 直连 ${directPreviewNodes.length}` : ""}
                </span>
              ) : null}
            </button>
            <CardDescription className="w-full text-xs">
              关掉开关只是不进订阅，转发照常运行。
            </CardDescription>
          </CardHeader>
          <CardContent hidden={previewCollapsed} className="pt-0">
            {previewQuery.isLoading ? (
              <DataSectionLoading />
            ) : (
              <div className="space-y-4">
                {(preview?.nodes.length ?? 0) === 0 ? (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    订阅里还没有节点。先添加落地节点，再在下面把转发加进来。
                  </p>
                ) : (
                  <div className="space-y-3">
                    {PREVIEW_GROUPS.map((group) => {
                      const groupNodes = group.key === "direct" ? directPreviewNodes : relayPreviewNodes;
                      if (groupNodes.length === 0) return null;
                      const collapsed = isGroupCollapsed(group.key);
                      return (
                        <div key={group.key} className="space-y-1.5">
                          <button
                            type="button"
                            className="flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground"
                            onClick={() => toggleGroup(group.key)}
                            aria-expanded={!collapsed}
                          >
                            <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
                            <span>{group.label}</span>
                            <span className="tabular-nums">({groupNodes.length})</span>
                            <span className="h-px flex-1 bg-border" />
                          </button>
                          {collapsed ? null : (
                            <div className="space-y-1.5">
                              {groupNodes.map((node: any) => {
                      // 直连条目不来自转发规则，ruleId 都是 0 —— 拿它当 key 会互相撞。
                      const direct = node.kind === "direct";
                      return (
                      <div
                        key={direct ? `direct-${node.templateId}` : `rule-${node.ruleId}`}
                        className="flex items-center gap-2 rounded-md border px-2.5 py-1.5"
                      >
                        <Eye className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium leading-tight">{node.name}</span>
                            {direct && (
                              <Badge variant="outline" className="h-4 shrink-0 px-1 text-[10px] font-normal">直连</Badge>
                            )}
                          </div>
                          <p className="truncate text-[11px] leading-tight text-muted-foreground">
                            {node.address}:{node.port}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            title="改这个节点在订阅里显示的名字"
                            onClick={() => {
                              setRenaming({
                                kind: direct ? "direct" : "relay",
                                ruleId: node.ruleId,
                                templateId: node.templateId,
                                name: node.name,
                              });
                              setRenameValue(node.name);
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          {/* 直连条目的显隐在节点模板上，这里不给开关，免得点了没反应。 */}
                          {!direct && (
                            <Switch
                              className="scale-90"
                              checked
                              onCheckedChange={() => setRuleVisible.mutate({ ruleId: node.ruleId, visible: false })}
                            />
                          )}
                        </div>
                      </div>
                      );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {hiddenRules.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">已隐藏（不在订阅里）</p>
                    {hiddenRules.map((item) => (
                      <div
                        key={item.ruleId}
                        className="flex items-center gap-2 rounded-md border border-dashed px-2.5 py-1.5"
                      >
                        <EyeOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{item.ruleName}</span>
                        <Switch
                          className="shrink-0 scale-90"
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
                      选这个组，客户端自动挑最快的中转。
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
          <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Link2 className="h-4 w-4" />
              订阅链接
            </CardTitle>
            <Button
              className="shrink-0"
              size="sm"
              onClick={() => {
                setTokenName("");
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
                          <div className="space-y-1.5 rounded-md border bg-background px-2 py-1.5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
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
                            {/* 光看"精简/均衡/完整"不知道差在哪，说明得跟着控件走。 */}
                            <p className="text-xs text-muted-foreground">{PROXY_RULE_PRESET_HINTS[preset]}</p>
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
                            // 运行时的优先：放在服务器上就能换图，不必重新构建。
                            const logo = runtimeLogos[target.id]
                              ? `/api/client-logos/${target.id}`
                              : CLIENT_LOGOS[target.id];
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
                        <div className="space-y-1.5">
                          <p className="text-xs text-muted-foreground">
                            其他客户端用这条地址手动添加。
                          </p>
                          {/* 这个设置只在「客户端标识认不出来」时才生效，所以就放在那句话下面。
                              上面图标点进去的地址都钉死了格式，走不到这里。 */}
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs text-muted-foreground">认不出来时按</span>
                            <Select
                              value={normalizeProxySubscriptionFormat(token.defaultFormat)}
                              onValueChange={(value) => updateToken.mutate({
                                id: token.id,
                                defaultFormat: value as ProxySubscriptionFormat,
                              })}
                            >
                              <SelectTrigger className="h-7 w-auto gap-1 text-xs">
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
                            <span className="text-xs text-muted-foreground">返回</span>
                          </div>
                        </div>
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
        {/* DialogContent 默认 max-h + overflow-hidden，内容超出直接裁掉、滚不动。
            改成 flex 列、正文单独一层可滚 —— 项目里其他长弹窗都是这个写法。 */}
        <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>{editingNodeId ? "编辑客户端节点" : "添加客户端节点"}</DialogTitle>
            <DialogDescription className="text-xs">只替换地址和端口，凭据不变。</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-1">
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
              <Label>加进订阅</Label>
              <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
                <p className="min-w-0 text-xs text-muted-foreground">
                  订阅里额外给出这个节点自己的地址。
                  {nodeIncludeDirect ? (
                    <span className="mt-1 block text-amber-600 dark:text-amber-500">
                      该节点 IP 会出现在每条订阅地址里。
                    </span>
                  ) : null}
                </p>
                <Switch
                  checked={nodeIncludeDirect}
                  onCheckedChange={setNodeIncludeDirect}
                  className="mt-0.5 shrink-0"
                />
              </div>
            </div>
            <div className="space-y-2 rounded-lg border p-3">
              <Label>这台落地机的套餐</Label>
              <div className="grid grid-cols-2 gap-2">
                <div className="min-w-0 space-y-1">
                  <Label className="text-xs text-muted-foreground">带宽（Mbps）</Label>
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={nodeBandwidthMbps}
                    onChange={(event) => setNodeBandwidthMbps(event.target.value)}
                    placeholder="500"
                  />
                </div>
                <div className="min-w-0 space-y-1">
                  <Label className="text-xs text-muted-foreground">总流量（GB）</Label>
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={nodeTrafficLimitGb}
                    onChange={(event) => setNodeTrafficLimitGb(event.target.value)}
                    placeholder="1000"
                  />
                </div>
              </div>
              {editingNodeId ? (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">已用流量（GB）</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      inputMode="numeric"
                      value={nodeTrafficUsedGb}
                      onChange={(event) => setNodeTrafficUsedGb(event.target.value)}
                      placeholder="0"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => setNodeTrafficUsedGb("")}
                    >
                      清零
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    面板自己会累加，这里只是用来跟机房的账单对齐。
                    <span className="mt-1 block text-amber-600 dark:text-amber-500">
                      面板只数得到经转发规则走过的流量 —— 订阅里的「直连」条目和这台机器上跑的别的服务都不计入，
                      所以这个数只会比机房账单小，不会大。
                    </span>
                  </p>
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-3 pt-1">
                <div className="min-w-0">
                  <Label className="text-xs">每月自动清零</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">按机房的流量周期来，日期只能填 1-28。</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {nodeTrafficAutoReset ? (
                    <Input
                      type="number"
                      inputMode="numeric"
                      className="h-8 w-16"
                      value={nodeTrafficResetDay}
                      onChange={(event) => setNodeTrafficResetDay(event.target.value)}
                    />
                  ) : null}
                  <Switch checked={nodeTrafficAutoReset} onCheckedChange={setNodeTrafficAutoReset} />
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <Label>前置代理</Label>
              <Select
                value={String(nodeFrontProxyId)}
                onValueChange={(value) => setNodeFrontProxyId(Number(value))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="不经由" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">不经由</SelectItem>
                  {nodes
                    .filter((item: any) => Number(item.id) !== editingNodeId)
                    .map((item: any) => (
                      <SelectItem key={item.id} value={String(item.id)}>
                        {item.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                连接先经由它建立。
                {nodeFrontProxyId > 0 ? (
                  <span className="mt-1 block text-amber-600 dark:text-amber-500">
                    Loon 与 QX 需在客户端里手连一次。
                  </span>
                ) : null}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="proxy-node-link">节点链接</Label>
              <Textarea
                id="proxy-node-link"
                value={nodeLink}
                onChange={(event) => setNodeLink(event.target.value)}
                placeholder={'vless:// vmess:// trojan:// ss:// hysteria2:// tuic:// anytls://\nSnell 没有链接，粘 Surge 那行：名字 = snell, 地址, 端口, psk=密钥, version=4\n或粘贴 JSON：{"type":"vless","server":"...","server_port":443,...}'}
                rows={5}
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
            <DialogDescription className="text-xs">
              建议一台设备一条。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="proxy-token-name">用途</Label>
            <Input
              id="proxy-token-name"
              value={tokenName}
              onChange={(event) => setTokenName(event.target.value)}
              placeholder="例如 我的手机"
            />
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
                // 格式与预设都在「一键订阅」面板里就地调整，创建时走服务端默认。
                createToken.mutate({ name });
              }}
              disabled={createToken.isPending}
            >
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!renaming} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>改节点名</DialogTitle>
            <DialogDescription className="text-xs">
              只影响这个节点在订阅里显示的名字，转发规则本身不受影响。
              {renaming?.kind === "direct" ? "这是直连条目，改的是节点模板的名字。" : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="proxy-rename">节点名</Label>
            <Input
              id="proxy-rename"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              maxLength={64}
              autoFocus
            />
            {renaming?.kind === "relay" && (
              <p className="text-xs text-muted-foreground">
                留空恢复默认名（由主机名和转发名自动拼出）。
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              取消
            </Button>
            <Button
              disabled={setRuleNodeName.isPending || updateNode.isPending}
              onClick={() => {
                if (!renaming) return;
                const name = renameValue.trim();
                if (renaming.kind === "direct") {
                  // 直连条目的名字就是模板名，落到模板上。
                  if (!name) {
                    toast.error("节点模板的名字不能为空");
                    return;
                  }
                  updateNode.mutate({ id: renaming.templateId, name });
                  setRenaming(null);
                  return;
                }
                setRuleNodeName.mutate({ ruleId: renaming.ruleId, name });
              }}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!qrTarget} onOpenChange={(open) => !open && setQrTarget(null)}>
        {/* DialogContent 是 grid，子项默认 min-width:auto —— 底下那条不可断行的长地址
            会把整列撑宽再被 overflow-hidden 切掉，所以这里逐层 min-w-0，地址本身也断行。 */}
        <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden sm:max-w-sm">
          <DialogHeader className="min-w-0 pr-8">
            <DialogTitle className="flex items-center gap-2">
              <QrCode className="h-4 w-4 shrink-0" />
              扫码导入
            </DialogTitle>
            <DialogDescription className="truncate text-xs">{qrTarget?.title}</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto overscroll-contain">
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
                在客户端的「添加订阅」里扫，别用系统相机。
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
              含完整凭据，别外发。
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
