import { useAuth } from "@/_core/hooks/useAuth";
import DataSectionLoading from "@/components/DataSectionLoading";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ProxyNodeRow, proxyNodeMetaText, type ProxyNodeRowSpec } from "@/components/proxy/ProxyNodeRow";
import { ProxyNodeShareDialog, type ProxyNodeShareTarget } from "@/components/proxy/ProxyNodeShareDialog";
import { clipboardNeedsManualCopy, copyTextFromElement, copyTextToClipboard } from "@/lib/clipboard";
import { trpc } from "@/lib/trpc";
import {
  PROXY_INBOUND_PROTOCOLS,
  PROXY_INBOUND_SECURITY_LABELS,
  PROXY_INBOUND_SNELL_VERSIONS,
  PROXY_INBOUND_SHADOWSOCKS_METHODS,
  PROXY_INBOUND_SHADOWSOCKS_DEFAULT_METHOD,
  isLegacyShadowsocksMethod,
  proxyInboundSecurities,
  proxyInboundSupportsMultiUser,
  proxyInboundTransports,
  type ProxyInboundProtocol,
  type ProxyInboundSecurity,
} from "@shared/proxyInbound";
import { PROXY_NODE_PROTOCOL_LABELS, type ProxyNodeProtocol, type ProxyNodeTransport } from "@shared/proxyNode";
import { groupProxyNodes, resolveProxyNodeGroupMode, type ProxyNodeGroupMode } from "@shared/proxyNodeGrouping";
import {
  ChevronDown,
  Copy,
  Eye,
  KeyRound,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Share2,
  Trash2,
  UserRound,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

const TRANSPORT_LABELS: Record<string, string> = {
  tcp: "TCP",
  ws: "WebSocket",
  grpc: "gRPC",
  http: "HTTP",
  httpupgrade: "HTTPUpgrade",
  xhttp: "XHTTP",
};

type InboundForm = {
  id: number;
  hostId: number;
  /** 这个入站归谁。归属决定节点进谁的订阅、流量扣谁的套餐；只有管理员改得动。 */
  userId: number;
  name: string;
  protocol: ProxyInboundProtocol;
  port: number;
  transport: ProxyNodeTransport;
  security: ProxyInboundSecurity;
  serverName: string;
  realityDest: string;
  path: string;
  host: string;
  certPath: string;
  keyPath: string;
  acmeEmail: string;
  obfs: string;
  obfsPassword: string;
  snellVersion: number;
  /** Shadowsocks 的加密方式。其他协议用不到，留着也不会下发。 */
  method: string;
  isEnabled: boolean;
  /** 只有 id 与名字：凭据一律服务端生成，前端拿不到也不该传。 */
  /** sharedUserId > 0 = 分享时自动发的凭据，界面上只读：它的生死跟着分享走。 */
  users: Array<{ id: number; name: string; sharedUserId?: number }>;
};

function emptyForm(): InboundForm {
  return {
    id: 0,
    hostId: 0,
    userId: 0,
    name: "",
    protocol: "vless",
    port: 443,
    transport: "tcp",
    security: "reality",
    serverName: "",
    realityDest: "",
    path: "",
    host: "",
    certPath: "",
    keyPath: "",
    acmeEmail: "",
    obfs: "",
    obfsPassword: "",
    snellVersion: PROXY_INBOUND_SNELL_VERSIONS[0],
    method: PROXY_INBOUND_SHADOWSOCKS_DEFAULT_METHOD,
    isEnabled: true,
    users: [{ id: 0, name: "默认" }],
  };
}

/**
 * 「我的节点」这张卡。
 *
 * 自建、粘贴、别人分享来的三类节点合成**一个**列表 —— 租户脑子里它们本来就是
 * 同一件事（「我有哪些线路」），分成三张卡是我们的实现细节漏到了界面上。
 *
 * 三类的开关和动作写的是不同字段，所以**行由各自的 owner 组装成 ProxyNodeRowSpec
 * 之后传进来**（粘贴/分享那两类走 extraRows），这里只负责分组和排版。这样不存在
 * 「在列表里按类型分支、结果接错线」的可能。
 */
export default function ProxyInboundsSection({
  extraRows = [],
  extraLoading = false,
  groupMode,
  onGroupModeChange,
  groupModeOptions,
  onPasteNode,
  inboundLeading,
  onOpenPreview,
  previewAlertCount = 0,
  onOpenHosts,
  onlineCount = 0,
  offlineCount = 0,
}: {
  /** 粘贴进来的、以及别人分享来的节点，由「订阅管理」那一页组装。 */
  extraRows?: ProxyNodeRowSpec[];
  extraLoading?: boolean;
  groupMode?: ProxyNodeGroupMode;
  onGroupModeChange?: (mode: ProxyNodeGroupMode) => void;
  groupModeOptions?: ReadonlyArray<{ value: ProxyNodeGroupMode; label: string }>;
  /** 「粘一条链接」走这条 —— 那个弹窗归「订阅管理」那一页管。 */
  onPasteNode?: () => void;
  /**
   * 自建行左边那个状态点。探测结果挂在派生节点上，是「订阅管理」那一页的数据，
   * 所以由它渲染再传进来 —— 合并之后两类行都得有这个点，否则一半有一半没有，
   * 看起来像自建节点永远查不出状态。
   */
  inboundLeading?: (inboundId: number) => ReactNode;
  onOpenPreview?: () => void;
  /**
   * 预览里等着处理的条数（现在是「还没加入订阅的转发」）。收进弹窗之后这个信号
   * 就看不见了 —— 转发建好了却没进订阅，用户只会以为订阅坏了，所以在按钮上留一个
   * 角标把它顶出来。
   */
  previewAlertCount?: number;
  /** 非管理员才有：「我的机器」降级成这里的一个入口。 */
  onOpenHosts?: () => void;
  onlineCount?: number;
  offlineCount?: number;
} = {}) {
  const { user: me } = useAuth();
  const isAdmin = me?.role === "admin";
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();
  const [collapsed, setCollapsed] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<InboundForm>(emptyForm());

  const inboundsQuery = trpc.proxyInbounds.list.useQuery();
  const optionsQuery = trpc.proxyInbounds.options.useQuery();
  const hostsQuery = trpc.hosts.list.useQuery();
  // 分租要用：管理员建入站时要能指定归属用户。普通用户只能开给自己，不必拉这份名单。
  const usersQuery = trpc.users.options.useQuery(undefined, {
    enabled: isAdmin,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const refresh = () => {
    void utils.proxyInbounds.list.invalidate();
    // 派生节点会跟着变，订阅那边的列表和预览都要重取。
    void utils.proxySubscriptions.listNodes.invalidate();
    void utils.proxySubscriptions.preview.invalidate();
  };

  const createInbound = trpc.proxyInbounds.create.useMutation({
    onSuccess: () => {
      toast.success("节点已创建，配置正在下发");
      setDialogOpen(false);
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const updateInbound = trpc.proxyInbounds.update.useMutation({
    onSuccess: () => {
      toast.success("节点已更新，配置正在下发");
      setDialogOpen(false);
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const rotateInbound = trpc.proxyInbounds.rotate.useMutation({
    onSuccess: () => {
      toast.success("凭据已重新生成，请让客户端更新订阅");
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  /**
   * 自建节点要不要进订阅，改的是它派生出来那条 proxy_node 的 includeDirect。
   * 直接复用订阅那边现成的 updateNode —— 派生节点本来就是一条 proxy_node，
   * 不必为此另开一个接口。多用户入站有好几条，一起改。
   */
  const updateNode = trpc.proxySubscriptions.updateNode.useMutation({
    onError: (error) => toast.error(error.message),
  });
  const setInSubscription = async (row: any, checked: boolean) => {
    const ids: number[] = Array.isArray(row.derivedNodeIds) ? row.derivedNodeIds : [];
    if (ids.length === 0) {
      toast.error("这个节点还没派生出客户端节点，通常是主机还没有可用地址");
      return;
    }
    await Promise.all(ids.map((id) => updateNode.mutateAsync({ id, includeDirect: checked })));
    toast.success(checked ? "已加进订阅" : "已从订阅移除");
    void utils.proxyInbounds.list.invalidate();
    void utils.proxySubscriptions.listNodes.invalidate();
    void utils.proxySubscriptions.preview.invalidate();
  };

  /**
   * 复制分享链接。一个用户一条，所以多用户入站要先让人挑一个。
   *
   * 链接是按需拉的（proxyInbounds.links），不跟着列表走：里面带着完整凭据，
   * 而列表是每次进页面都会拉的。
   */
  const [linkRows, setLinkRows] = useState<Array<{ userId: number; userName: string; name: string; link: string }>>([]);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkLoadingId, setLinkLoadingId] = useState(0);
  /**
   * 弹窗里每条链接对应的那个 <p>。
   *
   * 复制按钮直接选中它里面的文字 —— 等同于用户自己长按选中再复制，不依赖任何
   * 隐藏元素的技巧，是 iOS 上最稳的一条路。
   */
  const linkTextRefs = useRef<Record<number, HTMLParagraphElement | null>>({});

  /**
   * 从节点这边发起分享。
   *
   * 多凭据协议下分享是按**端口**算的：选中谁，面板就在这个端口上给谁单独发一
   * 份凭据，取消时只吊销他那一份。所以这里只给一个选人列表 —— 原来是「每份
   * 凭据各选各的人」，那是把「谁拿到了哪一份」交给管理员手工维护，而现在这
   * 件事由分享自己管。
   */
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareTargets, setShareTargets] = useState<ProxyNodeShareTarget[]>([]);
  const [shareCredentialMode, setShareCredentialMode] = useState<"per-recipient" | "shared">("shared");

  const openShare = (row: any) => {
    const derived: Array<{ id: number; inboundUserId: number }> = Array.isArray(row.derivedNodes) ? row.derivedNodes : [];
    const ids: number[] = (row.derivedNodeIds || []).map((id: any) => Number(id)).filter(Boolean);
    if (ids.length === 0) {
      toast.error("这个节点还没生成出客户端节点，保存一次再试");
      return;
    }
    const users: Array<{ id: number; name: string; sharedUserId?: number }> = Array.isArray(row.users) ? row.users : [];
    const multi = proxyInboundSupportsMultiUser(row.protocol);
    if (multi) {
      /**
       * 多凭据协议：分享是按**端口**来的 —— 选谁，就在这个端口上给谁单独发一份。
       * 所以只给一个选人列表，落点挑主人自己那份凭据派生的节点（分享发出去的
       * 那些本身已经是某个人的了，不该再拿去分享给第二个人）。
       */
      const ownIds = new Set(users.filter((user) => !Number(user.sharedUserId || 0)).map((user) => Number(user.id)));
      const anchor = derived.find((node) => ownIds.has(Number(node.inboundUserId)))?.id
        ?? derived[0]?.id
        ?? ids[0];
      setShareTargets([{ id: Number(anchor), label: "这个端口" }]);
    } else {
      // 单凭据协议：一个端口一份，分享出去的就是这一份。
      setShareTargets([{ id: ids[0], label: "这份凭据" }]);
    }
    setShareCredentialMode(multi ? "per-recipient" : "shared");
    setShareDialogOpen(true);
  };

  const copyLink = async (link: string) => {
    if (await copyTextToClipboard(link)) {
      toast.success("链接已复制，粘进客户端即可");
      return true;
    }
    return false;
  };

  const openLinks = async (row: any) => {
    setLinkLoadingId(Number(row.id));
    try {
      const rows = await utils.proxyInbounds.links.fetch({ id: Number(row.id) });
      if (rows.length === 0) {
        toast.error("这个节点还没生成出链接");
        return;
      }
      /**
       * 只有一条时先试着直接进剪贴板，成功就不弹窗 —— 单用户节点点一下就该好。
       *
       * 复制不成也要把弹窗打开：面板多半是 http://IP 访问的，浏览器不给网页写
       * 剪贴板，这时只能让人自己选中复制 —— 而原来只弹一句「请长按选中链接」，
       * 链接压根没显示出来，让人长按什么？
       */
      if (rows.length === 1 && await copyLink(rows[0].link)) return;
      setLinkRows(rows);
      setLinkDialogOpen(true);
    } catch (error: any) {
      toast.error(error?.message || "取链接失败");
    } finally {
      setLinkLoadingId(0);
    }
  };

  const deleteInbound = trpc.proxyInbounds.delete.useMutation({
    onSuccess: () => {
      toast.success("节点已删除");
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const hosts = (hostsQuery.data || []) as any[];
  const hostName = (hostId: number) => hosts.find((item) => Number(item.id) === Number(hostId))?.name || `主机 #${hostId}`;

  const userOptions = (usersQuery.data || []) as any[];
  const ownerLabel = (userId: number) => {
    const found = userOptions.find((item) => Number(item.id) === Number(userId));
    if (!found) return `用户 #${userId}`;
    return String(found.username || found.name || `用户 #${userId}`);
  };

  // 协议一变，能选的传输与安全层就变了，选项要跟着收窄而不是让用户选完再报错。
  const transports = useMemo(() => proxyInboundTransports(form.protocol), [form.protocol]);
  const securities = useMemo(() => proxyInboundSecurities(form.protocol), [form.protocol]);

  const setProtocol = (protocol: ProxyInboundProtocol) => {
    setForm((prev) => {
      const nextTransports = proxyInboundTransports(protocol);
      const nextSecurities = proxyInboundSecurities(protocol);
      return {
        ...prev,
        protocol,
        transport: nextTransports.includes(prev.transport) ? prev.transport : nextTransports[0],
        security: nextSecurities.includes(prev.security) ? prev.security : nextSecurities[0],
      };
    });
  };

  const openCreate = () => {
    const first = hosts[0];
    setForm({ ...emptyForm(), hostId: first ? Number(first.id) : 0, userId: Number(me?.id || 0) });
    setDialogOpen(true);
  };

  const openEdit = (row: any) => {
    setForm({
      id: Number(row.id),
      hostId: Number(row.hostId),
      userId: Number(row.userId || 0),
      name: String(row.name || ""),
      protocol: String(row.protocol || "vless") as ProxyInboundProtocol,
      port: Number(row.port || 0),
      transport: String(row.transport || "tcp") as ProxyNodeTransport,
      security: String(row.security || "reality") as ProxyInboundSecurity,
      serverName: String(row.serverName || ""),
      realityDest: String(row.realityDest || ""),
      path: String(row.path || ""),
      host: String(row.host || ""),
      certPath: String(row.certPath || ""),
      keyPath: String(row.keyPath || ""),
      acmeEmail: String(row.acmeEmail || ""),
      obfs: String(row.obfs || ""),
      obfsPassword: String(row.obfsPassword || ""),
      snellVersion: Number(row.snellVersion || PROXY_INBOUND_SNELL_VERSIONS[0]),
      method: String(row.method || PROXY_INBOUND_SHADOWSOCKS_DEFAULT_METHOD),
      isEnabled: !!row.isEnabled,
      users: Array.isArray(row.users) && row.users.length > 0
        ? row.users.map((user: any) => ({
          id: Number(user.id) || 0,
          name: String(user.name || ""),
          sharedUserId: Number(user.sharedUserId || 0),
        }))
        : [{ id: 0, name: "默认" }],
    });
    setDialogOpen(true);
  };

  const submit = () => {
    if (!form.hostId) return toast.error("请选择一台主机");
    if (!form.name.trim()) return toast.error("请填写名称");
    const payload = {
      hostId: form.hostId,
      // 只有管理员能改归属；普通用户不传，后端按操作者自己算。
      ...(isAdmin && form.userId > 0 ? { userId: form.userId } : {}),
      name: form.name.trim(),
      protocol: form.protocol,
      port: form.port,
      transport: form.transport,
      security: form.security,
      serverName: form.serverName.trim(),
      realityDest: form.realityDest.trim(),
      path: form.path.trim(),
      host: form.host.trim(),
      certPath: form.certPath.trim(),
      keyPath: form.keyPath.trim(),
      acmeEmail: form.acmeEmail.trim(),
      obfs: form.obfs.trim(),
      obfsPassword: form.obfsPassword.trim(),
      snellVersion: form.snellVersion,
      method: form.method,
      isEnabled: form.isEnabled,
      users: form.users.map((user, index) => ({ id: user.id, name: user.name.trim() || `凭据 ${index + 1}` })),
    };
    if (form.id > 0) updateInbound.mutate({ id: form.id, ...payload });
    else createInbound.mutate(payload);
  };

  const askRotate = async (row: any) => {
    const ok = await confirm({
      title: "重新生成凭据？",
      // 说清后果：这不是一个可以随便点的按钮。
      description: `「${row.name}」的 UUID / 密码 / REALITY 密钥会全部换掉。所有客户端都要重新拉一次订阅才能连上。`,
      confirmText: "重新生成",
    });
    if (ok) rotateInbound.mutate({ id: Number(row.id) });
  };

  const askDelete = async (row: any) => {
    const ok = await confirm({
      title: "删除节点？",
      description: `「${row.name}」会停止监听，它派生的客户端节点也会从订阅里移除。绑定过它的转发规则会自动解绑，转发本身继续运行。`,
      confirmText: "删除",
      tone: "destructive",
    });
    if (ok) deleteInbound.mutate({ id: Number(row.id) });
  };

  const rows = (inboundsQuery.data || []) as any[];
  /**
   * 自建节点这一路的行规格。
   *
   * 组装在这里而不是在列表里：它的开关写的是派生节点的 includeDirect，跟粘贴那一
   * 路写的完全不是一个字段。各自组装好再汇到一个列表，接错线这件事就不可能发生。
   */
  const inboundRowSpecs = useMemo<ProxyNodeRowSpec[]>(() => rows.map((row) => ({
    key: `inbound-${row.id}`,
    leading: inboundLeading?.(Number(row.id)),
    name: row.name,
    protocol: String(row.protocol || ""),
    sortName: String(row.name || ""),
    tag: (
      <Badge variant="secondary" className="h-4 shrink-0 px-1 text-[10px] font-normal">
        {PROXY_NODE_PROTOCOL_LABELS[row.protocol as ProxyNodeProtocol] || row.protocol}
      </Badge>
    ),
    muted: !row.isEnabled,
    // 地址排最前：它是这一行里最常要看的，排后面就会被前面的安全层、归属挤到
    // 省略号里去。来源（自建）紧跟其后 —— 合成一个列表之后，那是认出这行是什么
    // 的第一眼信息。
    meta: proxyNodeMetaText([
      "自建",
      `${hostName(Number(row.hostId))}:${row.port}`,
      row.security !== "none"
        ? PROXY_INBOUND_SECURITY_LABELS[row.security as ProxyInboundSecurity] || row.security
        : "",
      row.transport && row.transport !== "tcp" ? TRANSPORT_LABELS[row.transport] || row.transport : "",
      isAdmin ? `归 ${ownerLabel(Number(row.userId))}` : "",
      Array.isArray(row.users) && row.users.length > 1 ? `${row.users.length} 份凭据` : "",
      Number(row.sharedUserCount || 0) > 0 ? `分享给 ${row.sharedUserCount} 人` : "",
      // 套餐附带的专属端口是面板托管的，标出来，免得人以为是自己建的。
      Number(row.clonedFromInboundId || 0) > 0 ? "套餐附带 · 面板托管" : "",
      !row.isEnabled ? "已停用" : "",
    ]),
    toggle: (
      <Switch
        className="shrink-0 scale-90"
        checked={!!row.includeDirect}
        title={row.includeDirect ? "已在订阅里，关掉就不出现" : "加进订阅"}
        onCheckedChange={(checked) => void setInSubscription(row, checked)}
      />
    ),
    actions: [
      {
        key: "link",
        label: "复制链接",
        icon: Link2,
        disabled: linkLoadingId === Number(row.id),
        onSelect: () => void openLinks(row),
      },
      ...(isAdmin
        ? [{ key: "share", label: "分享给用户", icon: Share2, onSelect: () => openShare(row) }]
        : []),
      /**
       * 面板托管的专属端口不给编辑和删除。
       *
       * 删了下一次权益重算又会建回来 —— 中间那段时间他自己连不上，而界面上看不出
       * 是自己删的。改也一样：源入站一变就被覆盖。要停就去改套餐，那才是它的来源。
       */
      ...(Number(row.clonedFromInboundId || 0) > 0
        ? []
        : [
          { key: "edit", label: "编辑", icon: Pencil, onSelect: () => openEdit(row) },
          { key: "rotate", label: "重置凭据", icon: KeyRound, onSelect: () => void askRotate(row) },
          { key: "delete", label: "删除", icon: Trash2, destructive: true, onSelect: () => void askDelete(row) },
        ]),
    ],
  })), [rows, hosts, userOptions, isAdmin, linkLoadingId, inboundLeading]);

  /** 三类合成一个列表：自建在前（它们是这一页的起点），然后是粘贴和分享来的。 */
  const allRowSpecs = useMemo(() => [...inboundRowSpecs, ...extraRows], [inboundRowSpecs, extraRows]);
  const totalRowCount = allRowSpecs.length;
  /**
   * 分组沿用订阅那一套（按协议 / 自动），只是现在作用在合并后的整张列表上。
   * 传 protocol 进去就够 —— groupProxyNodes 只看这一个字段。
   */
  /**
   * groupProxyNodes 要的是 { id, protocol, health }，而行规格里没有 id ——
   * 给它一个稳定的序号就行：分组只按协议看，id 只用来做键。
   */
  const groupableRows = useMemo(
    () => allRowSpecs.map((spec, index) => ({ ...spec, id: index + 1, protocol: spec.protocol || "" })),
    [allRowSpecs],
  );
  const effectiveGroupMode = useMemo(
    () => resolveProxyNodeGroupMode(groupMode || "none", groupableRows as any),
    [groupMode, groupableRows],
  );
  const nodeGroups = useMemo(
    () => groupProxyNodes(groupableRows, groupMode || "none"),
    [groupableRows, groupMode],
  );

  const saving = createInbound.isPending || updateInbound.isPending;
  const isReality = form.security === "reality";
  const isTls = form.security === "tls";
  const isAcme = form.security === "acme";
  const hasTransportOptions = transports.length > 1;
  const multiUser = proxyInboundSupportsMultiUser(form.protocol);
  const usesPath = form.transport === "ws" || form.transport === "grpc" || form.transport === "http";

  return (
    <>
      <div className="space-y-4">
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
            <button
              type="button"
              className="flex min-w-0 items-center gap-2 text-left"
              onClick={() => setCollapsed((prev) => !prev)}
              aria-expanded={!collapsed}
            >
              <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
              <Server className="h-4 w-4 shrink-0" />
              <CardTitle className="text-base">我的节点</CardTitle>
              {totalRowCount > 0 ? (
                <span className="truncate text-xs text-muted-foreground">
                  {totalRowCount} 个
                  {onlineCount > 0 ? ` · ${onlineCount} 在线` : ""}
                  {offlineCount > 0 ? ` · ${offlineCount} 离线` : ""}
                </span>
              ) : null}
            </button>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {/* 分组只在真的有好几条时才给 —— 两条节点摆个分组下拉是噪音。 */}
              {groupMode && onGroupModeChange && groupModeOptions && totalRowCount > 1 ? (
                <Select value={groupMode} onValueChange={(value) => onGroupModeChange(value as ProxyNodeGroupMode)}>
                  <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {groupModeOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              {onOpenHosts ? (
                <Button size="sm" variant="outline" onClick={onOpenHosts}>
                  <Server className="mr-1 h-4 w-4" />
                  我的机器
                </Button>
              ) : null}
              {onOpenPreview ? (
                /* 「订阅内容」本来就是预览，不该常驻一张卡 —— 收成一个按钮。 */
                <Button size="sm" variant="outline" className="relative" onClick={onOpenPreview}>
                  <Eye className="mr-1 h-4 w-4" />
                  预览订阅
                  {previewAlertCount > 0 ? (
                    <span className="ml-1 rounded-full bg-amber-500/15 px-1.5 text-[11px] font-medium tabular-nums text-amber-600 dark:text-amber-400">
                      {previewAlertCount}
                    </span>
                  ) : null}
                </Button>
              ) : null}
              {onPasteNode ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm">
                      <Plus className="mr-1 h-4 w-4" />
                      新建
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {/*
                      两种来源都在这一个入口里：一个是让面板去自己的机器上开端口，
                      一个是把别处的链接粘进来。没有可用主机时前者是灰的，并在下面
                      给出原因 —— 不能只给个灰按钮让人猜。
                    */}
                    <DropdownMenuItem disabled={hosts.length === 0} onSelect={() => openCreate()}>
                      在我的机器上开一个
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onPasteNode()}>
                      粘一条节点链接
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Button size="sm" onClick={openCreate} disabled={hosts.length === 0}>
                  <Plus className="mr-1 h-4 w-4" />
                  新建
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent hidden={collapsed} className="pt-0">
            {inboundsQuery.isLoading || extraLoading ? (
              <DataSectionLoading />
            ) : totalRowCount === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                还没有节点。可以让面板在你自己的机器上开一个（REALITY 不需要域名和证书），
                也可以把别处的节点链接粘进来。
              </p>
            ) : (
              <div className="space-y-3">
                {nodeGroups.map((group) => {
                  // 不分组时只有一组，没必要给它加个「全部」标题占一行。
                  const showHeader = effectiveGroupMode !== "none";
                  return (
                    <div key={group.key} className="space-y-1.5">
                      {showHeader ? (
                        <p className="px-1 text-[11px] font-medium text-muted-foreground">
                          {group.label}
                          <span className="ml-1 tabular-nums">({group.nodes.length})</span>
                        </p>
                      ) : null}
                      {group.nodes.map((spec) => (
                        <ProxyNodeRow
                          key={spec.key}
                          leading={spec.leading}
                          name={spec.name}
                          tag={spec.tag}
                          meta={spec.meta}
                          detail={spec.detail}
                          inline={spec.inline}
                          toggle={spec.toggle}
                          actions={spec.actions}
                          muted={spec.muted}
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
            {hosts.length === 0 ? (
              <p className="mt-3 text-xs text-amber-600 dark:text-amber-500">
                {/*
                  「主机管理」对普通用户是关着的（侧边栏藏了，路由也是 AdminRoute），
                  所以不能对所有人都说「先去主机管理装一台」—— 那是一句他做不到的指示。
                */}
                {isAdmin
                  ? "没有可用主机，所以不能让面板替你开端口。自建节点要靠 Agent 下发配置，先去「主机管理」装一台。"
                  : "没有可用主机，所以不能让面板替你开端口。可以在「我的机器」里加一台自己的，也可以让管理员授权一台；粘贴别处的节点链接不受影响。"}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.id > 0 ? "编辑节点" : "新建节点"}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="min-w-0 space-y-1.5">
                <Label className="text-xs">主机</Label>
                <Select value={String(form.hostId || "")} onValueChange={(value) => setForm((prev) => ({ ...prev, hostId: Number(value) }))}>
                  <SelectTrigger><SelectValue placeholder="选择主机" /></SelectTrigger>
                  <SelectContent>
                    {hosts.map((item) => (
                      <SelectItem key={item.id} value={String(item.id)}>{item.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label className="text-xs">名称</Label>
                <Input value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} placeholder="HK 落地" />
              </div>
              {isAdmin ? (
                <div className="min-w-0 space-y-1.5 sm:col-span-2">
                  <Label className="text-xs">
                    <UserRound className="mr-1 inline h-3 w-3" />
                    归属用户
                  </Label>
                  <Select value={String(form.userId || "")} onValueChange={(value) => setForm((prev) => ({ ...prev, userId: Number(value) }))}>
                    <SelectTrigger><SelectValue placeholder="选择用户" /></SelectTrigger>
                    <SelectContent>
                      {userOptions.map((item) => (
                        <SelectItem key={item.id} value={String(item.id)} disabled={!item.allowProxySubscription && item.role !== "admin"}>
                          {item.username || item.name}
                          {!item.allowProxySubscription && item.role !== "admin" ? "（无订阅权限）" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    节点会进这个人的订阅，这个端口的流量也扣他的套餐额度、超额自动停。
                    一台机器上开多个端口分给不同人，各自只看得到自己那份用量。
                    灰掉的用户还没有客户端订阅权限，去「用户管理」里开通后才能选。
                  </p>
                </div>
              ) : null}
              <div className="min-w-0 space-y-1.5">
                <Label className="text-xs">协议</Label>
                <Select value={form.protocol} onValueChange={(value) => setProtocol(value as ProxyInboundProtocol)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PROXY_INBOUND_PROTOCOLS.map((protocol) => (
                      <SelectItem key={protocol} value={protocol}>
                        {PROXY_NODE_PROTOCOL_LABELS[protocol as ProxyNodeProtocol]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label className="text-xs">监听端口</Label>
                <Input
                  type="number"
                  value={form.port || ""}
                  onChange={(event) => setForm((prev) => ({ ...prev, port: Number(event.target.value) || 0 }))}
                />
              </div>
              {hasTransportOptions ? (
                <div className="min-w-0 space-y-1.5">
                  <Label className="text-xs">传输</Label>
                  <Select value={form.transport} onValueChange={(value) => setForm((prev) => ({ ...prev, transport: value as ProxyNodeTransport }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {transports.map((item) => (
                        <SelectItem key={item} value={item}>{TRANSPORT_LABELS[item] || item}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              {securities.length > 1 ? (
                <div className="min-w-0 space-y-1.5">
                  <Label className="text-xs">安全层</Label>
                  <Select value={form.security} onValueChange={(value) => setForm((prev) => ({ ...prev, security: value as ProxyInboundSecurity }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {securities.map((item) => (
                        <SelectItem key={item} value={item}>{PROXY_INBOUND_SECURITY_LABELS[item]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              {form.protocol === "shadowsocks" ? (
                <div className="min-w-0 space-y-1.5 sm:col-span-2">
                  <Label className="text-xs">加密方式</Label>
                  <Select value={form.method} onValueChange={(value) => setForm((prev) => ({ ...prev, method: value }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PROXY_INBOUND_SHADOWSOCKS_METHODS.map((item) => (
                        <SelectItem key={item} value={item}>
                          {item}
                          {item === PROXY_INBOUND_SHADOWSOCKS_DEFAULT_METHOD ? "（推荐）" : ""}
                          {isLegacyShadowsocksMethod(item) ? "（旧版）" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {isLegacyShadowsocksMethod(form.method) ? (
                    <p className="text-xs text-amber-600 dark:text-amber-500">
                      老式 AEAD 有已知的主动探测手段，中间设备能把这类流量识别出来。
                      只在对端客户端太旧、不支持 SS2022 时才用它。
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      AES-128 不比 256 弱（128 位密钥没有可行攻击）而且更快，小机器上差别明显，所以默认它。
                    </p>
                  )}
                </div>
              ) : null}
              {form.protocol === "snell" ? (
                <div className="min-w-0 space-y-1.5">
                  <Label className="text-xs">Snell 版本</Label>
                  <Select value={String(form.snellVersion)} onValueChange={(value) => setForm((prev) => ({ ...prev, snellVersion: Number(value) }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PROXY_INBOUND_SNELL_VERSIONS.map((version) => (
                        <SelectItem key={version} value={String(version)}>v{version}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>

            {isReality ? (
              <div className="space-y-3 rounded-md border p-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">要偷的握手域名</Label>
                  <Input
                    value={form.serverName}
                    onChange={(event) => setForm((prev) => ({ ...prev, serverName: event.target.value }))}
                    placeholder={optionsQuery.data?.defaultRealityServerName || "dl.google.com"}
                  />
                  <p className="text-xs text-muted-foreground">
                    留空按默认值。REALITY 不需要域名和证书，密钥对由面板生成。
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">握手目标（可选）</Label>
                  <Input
                    value={form.realityDest}
                    onChange={(event) => setForm((prev) => ({ ...prev, realityDest: event.target.value }))}
                    placeholder="留空按握手域名的 443"
                  />
                </div>
              </div>
            ) : null}

            {isAcme ? (
              <div className="space-y-3 rounded-md border p-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">域名</Label>
                  <Input
                    value={form.serverName}
                    onChange={(event) => setForm((prev) => ({ ...prev, serverName: event.target.value }))}
                    placeholder="a.example.com"
                  />
                  <p className="text-xs text-muted-foreground">
                    这个域名要先解析到这台落地机，签证书时会来验。填 IP 签不出来。
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">邮箱</Label>
                  <Input
                    value={form.acmeEmail}
                    onChange={(event) => setForm((prev) => ({ ...prev, acmeEmail: event.target.value }))}
                    placeholder="you@example.com"
                  />
                  <p className="text-xs text-muted-foreground">
                    注册 Let's Encrypt 账户用，证书快到期时会发提醒到这里。
                  </p>
                </div>
                <p className="text-xs text-amber-600 dark:text-amber-500">
                  签证书需要落地机的 80 或 443 端口能从公网访问到。证书由落地机自己申请和续期，私钥不经过面板。
                </p>
              </div>
            ) : null}

            {isTls ? (
              <div className="space-y-3 rounded-md border p-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">证书域名</Label>
                  <Input value={form.serverName} onChange={(event) => setForm((prev) => ({ ...prev, serverName: event.target.value }))} placeholder="a.example.com" />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="min-w-0 space-y-1.5">
                    <Label className="text-xs">证书路径</Label>
                    <Input value={form.certPath} onChange={(event) => setForm((prev) => ({ ...prev, certPath: event.target.value }))} placeholder="/etc/ssl/fullchain.pem" />
                  </div>
                  <div className="min-w-0 space-y-1.5">
                    <Label className="text-xs">私钥路径</Label>
                    <Input value={form.keyPath} onChange={(event) => setForm((prev) => ({ ...prev, keyPath: event.target.value }))} placeholder="/etc/ssl/privkey.pem" />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  路径是落地机上的本地路径，证书要先自己放上去。不想折腾证书就改用 REALITY。
                </p>
              </div>
            ) : null}

            {usesPath ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="min-w-0 space-y-1.5">
                  <Label className="text-xs">{form.transport === "grpc" ? "服务名" : "路径"}</Label>
                  <Input value={form.path} onChange={(event) => setForm((prev) => ({ ...prev, path: event.target.value }))} placeholder={form.transport === "grpc" ? "gsvc" : "/ray"} />
                </div>
                {form.transport !== "grpc" ? (
                  <div className="min-w-0 space-y-1.5">
                    <Label className="text-xs">Host 头</Label>
                    <Input value={form.host} onChange={(event) => setForm((prev) => ({ ...prev, host: event.target.value }))} />
                  </div>
                ) : null}
              </div>
            ) : null}

            {form.protocol === "hysteria2" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="min-w-0 space-y-1.5">
                  <Label className="text-xs">混淆</Label>
                  <Select value={form.obfs || "none"} onValueChange={(value) => setForm((prev) => ({ ...prev, obfs: value === "none" ? "" : value }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">不混淆</SelectItem>
                      <SelectItem value="salamander">salamander</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {form.obfs ? (
                  <div className="min-w-0 space-y-1.5">
                    <Label className="text-xs">混淆密码</Label>
                    <Input value={form.obfsPassword} onChange={(event) => setForm((prev) => ({ ...prev, obfsPassword: event.target.value }))} placeholder="留空自动生成" />
                  </div>
                ) : null}
              </div>
            ) : null}

            {multiUser ? (
              <div className="space-y-2 rounded-md border p-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs">
                    <KeyRound className="mr-1 inline h-3 w-3" />
                    凭据（{form.users.length}）
                  </Label>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setForm((prev) => ({
                      ...prev,
                      users: [...prev.users, { id: 0, name: `凭据 ${prev.users.length + 1}` }],
                    }))}
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    再发一份
                  </Button>
                </div>
                {form.users.map((user, index) => {
                  /**
                   * 分享自动发的凭据在这里是只读的：它的生死跟着「分享给谁」走。
                   * 在这个弹窗里删掉它并不会取消分享，只会让对方莫名其妙连不上，
                   * 而分享名单上他还在。
                   */
                  const fromShare = Number(user.sharedUserId || 0) > 0;
                  return (
                    <div key={`${user.id}-${index}`} className="flex items-center gap-2">
                      <Input
                        value={user.name}
                        readOnly={fromShare}
                        onChange={(event) => setForm((prev) => ({
                          ...prev,
                          users: prev.users.map((item, at) => (at === index ? { ...item, name: event.target.value } : item)),
                        }))}
                        placeholder={`给谁用，例如 小王 / 备用机`}
                        className={`h-8 text-xs ${fromShare ? "text-muted-foreground" : ""}`}
                        title={fromShare ? "分享给这个用户时自动发的凭据，改名或删除都请去分享那边操作" : undefined}
                      />
                      {fromShare ? (
                        <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">分享发出</span>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          // 至少留一份：零用户的入站 sing-box 会拒绝整份配置。
                          disabled={form.users.length <= 1}
                          onClick={() => setForm((prev) => ({ ...prev, users: prev.users.filter((_, at) => at !== index) }))}
                          title={form.users.length <= 1 ? "至少要留一份凭据" : "删除"}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  );
                })}
                <p className="text-xs text-muted-foreground">
                  同一个端口、同一份配置，只是凭据不同：一份凭据在订阅里是一条单独的节点，名字叫「入站名 · 这里填的标签」。
                  删掉一份，只有拿那份的人连不上，别人照常。
                  <br />
                  这里的标签只是给你自己认人用的，跟上面的「归属用户」和面板账号没有绑定；流量按端口统计，分不到每一份头上。
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {PROXY_NODE_PROTOCOL_LABELS[form.protocol as ProxyNodeProtocol]} 这个端口只能发一份凭据，谁拿到都一样。
                想一人一份、能单独吊销，改用 VLESS / VMess / Trojan / Hysteria2 / TUIC / AnyTLS。
              </p>
            )}

            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="min-w-0">
                <Label className="text-xs">启用</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">停用后落地机不再监听，订阅里也不会有它。</p>
              </div>
              <Switch checked={form.isEnabled} onCheckedChange={(checked) => setForm((prev) => ({ ...prev, isEnabled: checked }))} />
            </div>

            {form.id > 0 ? (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                <RefreshCw className="mr-1 inline h-3 w-3" />
                改协议、安全层或加密方式会重新生成凭据，客户端要重新拉一次订阅。
                {isAdmin ? "换归属用户会把节点从原主人的订阅里移走，他已导入的客户端会少掉这个节点。" : ""}
              </p>
            ) : null}
          </div>
          <DialogFooter className="shrink-0 border-t pt-3">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={submit} disabled={saving}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ProxyNodeShareDialog
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
        targets={shareTargets}
        credentialMode={shareCredentialMode}
      />

      <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
        <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>复制节点链接</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
            {linkRows.map((item) => (
              <div key={item.userId} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium leading-tight">{item.userName || item.name}</p>
                  {/* select-all + break-all：复制不了的时候要能一下选中整条，
                      truncate 会把后半截藏起来，选也选不全。 */}
                  <p
                    ref={(node) => { linkTextRefs.current[item.userId] = node; }}
                    className="select-all break-all font-mono text-[11px] leading-tight text-muted-foreground"
                  >
                    {item.link}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  title="复制"
                  onClick={async () => {
                    const ok = await copyTextFromElement(linkTextRefs.current[item.userId] || null, item.link);
                    if (ok) toast.success("链接已复制，粘进客户端即可");
                    // 失败时选区还留着，用户直接用系统菜单复制就行。
                    else toast.error("浏览器拒绝了复制，链接已选中，用系统菜单复制即可");
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            {clipboardNeedsManualCopy() ? (
              <p className="pt-1 text-xs text-muted-foreground">
                当前是 http 访问，没有剪贴板 API，只能走旧办法，有些浏览器（iOS 尤其）会拒绝。
                一键复制不成时，长按上面的链接选中即可。
              </p>
            ) : null}
            <p className="pt-1 text-xs text-amber-600 dark:text-amber-500">
              链接里带着这一份完整凭据，发给谁，谁就能用这个节点。
            </p>
          </div>
          <DialogFooter className="shrink-0 border-t pt-3">
            <Button variant="outline" onClick={() => setLinkDialogOpen(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
