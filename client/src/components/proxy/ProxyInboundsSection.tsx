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
import { ChevronDown, KeyRound, Pencil, Plus, Radio, RefreshCw, Server, Trash2, UserPlus, UserRound, Users } from "lucide-react";
import { useMemo, useState } from "react";
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
  users: Array<{ id: number; name: string }>;
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

export default function ProxyInboundsSection() {
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
        ? row.users.map((user: any) => ({ id: Number(user.id) || 0, name: String(user.name || "") }))
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
      users: form.users.map((user, index) => ({ id: user.id, name: user.name.trim() || `用户 ${index + 1}` })),
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
            {/* 与「落地节点」「订阅内容」同一套折叠交互：这一页现在有好几段，都要能收起来。 */}
            <button
              type="button"
              className="flex min-w-0 items-center gap-2 text-left"
              onClick={() => setCollapsed((prev) => !prev)}
              aria-expanded={!collapsed}
            >
              <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
              <Radio className="h-4 w-4 shrink-0" />
              <CardTitle className="text-base">新建节点</CardTitle>
              {rows.length > 0 ? (
                <span className="truncate text-xs text-muted-foreground">{rows.length} 个</span>
              ) : null}
            </button>
            <Button size="sm" onClick={openCreate} disabled={hosts.length === 0}>
              <Plus className="mr-1 h-4 w-4" />
              新建
            </Button>
          </CardHeader>
          <CardContent hidden={collapsed} className="pt-0">
            {inboundsQuery.isLoading ? (
              <DataSectionLoading />
            ) : rows.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                还没有节点。REALITY 不需要域名和证书，建完就能用。
              </p>
            ) : (
              <div className="space-y-1.5">
                {rows.map((row) => (
                  <div key={row.id} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium leading-tight">{row.name}</span>
                        <Badge variant="secondary" className="h-4 shrink-0 px-1 text-[10px] font-normal">
                          {PROXY_NODE_PROTOCOL_LABELS[row.protocol as ProxyNodeProtocol] || row.protocol}
                        </Badge>
                        {row.security !== "none" ? (
                          <Badge variant="outline" className="h-4 shrink-0 px-1 text-[10px] font-normal">
                            {PROXY_INBOUND_SECURITY_LABELS[row.security as ProxyInboundSecurity] || row.security}
                          </Badge>
                        ) : null}
                        {!row.isEnabled ? (
                          <Badge variant="outline" className="h-4 shrink-0 px-1 text-[10px] font-normal text-muted-foreground">停用</Badge>
                        ) : null}
                      </div>
                      <p className="truncate text-[11px] leading-tight text-muted-foreground">
                        <Server className="mr-1 inline h-3 w-3" />
                        {hostName(Number(row.hostId))} · 端口 {row.port}
                        {isAdmin ? ` · 归 ${ownerLabel(Number(row.userId))}` : ""}
                        {row.transport && row.transport !== "tcp" ? ` · ${TRANSPORT_LABELS[row.transport] || row.transport}` : ""}
                        {Array.isArray(row.users) && row.users.length > 1 ? ` · ${row.users.length} 个用户` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(row)} title="编辑">
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => void askRotate(row)} title="重新生成凭据">
                        <KeyRound className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => void askDelete(row)} title="删除">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {hosts.length === 0 ? (
              <p className="mt-3 text-xs text-amber-600 dark:text-amber-500">
                还没有可用主机。自建节点要靠 Agent 下发配置，先去「主机管理」装一台。
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
                    <Users className="mr-1 inline h-3 w-3" />
                    用户（{form.users.length}）
                  </Label>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setForm((prev) => ({
                      ...prev,
                      users: [...prev.users, { id: 0, name: `用户 ${prev.users.length + 1}` }],
                    }))}
                  >
                    <UserPlus className="mr-1 h-3 w-3" />
                    加一个
                  </Button>
                </div>
                {form.users.map((user, index) => (
                  <div key={`${user.id}-${index}`} className="flex items-center gap-2">
                    <Input
                      value={user.name}
                      onChange={(event) => setForm((prev) => ({
                        ...prev,
                        users: prev.users.map((item, at) => (at === index ? { ...item, name: event.target.value } : item)),
                      }))}
                      placeholder={`用户 ${index + 1}`}
                      className="h-8 text-xs"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      // 至少留一个：零用户的入站 sing-box 会拒绝整份配置。
                      disabled={form.users.length <= 1}
                      onClick={() => setForm((prev) => ({ ...prev, users: prev.users.filter((_, at) => at !== index) }))}
                      title={form.users.length <= 1 ? "至少要有一个用户" : "删除"}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">
                  每个用户一份独立凭据，各自派生一个节点进订阅。删掉某个用户，只有他连不上，其他人不受影响。
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {PROXY_NODE_PROTOCOL_LABELS[form.protocol as ProxyNodeProtocol]} 只支持单用户。
                要给多个人发不同凭据，改用 VLESS / VMess / Trojan / Hysteria2 / TUIC / AnyTLS。
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
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={submit} disabled={saving}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
