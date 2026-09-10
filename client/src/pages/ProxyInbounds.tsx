import DashboardLayout from "@/components/DashboardLayout";
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
  proxyInboundSecurities,
  proxyInboundTransports,
  type ProxyInboundProtocol,
  type ProxyInboundSecurity,
} from "@shared/proxyInbound";
import { PROXY_NODE_PROTOCOL_LABELS, type ProxyNodeProtocol, type ProxyNodeTransport } from "@shared/proxyNode";
import { KeyRound, Pencil, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

const TRANSPORT_LABELS: Record<string, string> = {
  tcp: "TCP",
  ws: "WebSocket",
  grpc: "gRPC",
  http: "HTTP",
  xhttp: "XHTTP",
};

type InboundForm = {
  id: number;
  hostId: number;
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
  obfs: string;
  obfsPassword: string;
  snellVersion: number;
  isEnabled: boolean;
};

function emptyForm(): InboundForm {
  return {
    id: 0,
    hostId: 0,
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
    obfs: "",
    obfsPassword: "",
    snellVersion: PROXY_INBOUND_SNELL_VERSIONS[0],
    isEnabled: true,
  };
}

export default function ProxyInbounds() {
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<InboundForm>(emptyForm());

  const inboundsQuery = trpc.proxyInbounds.list.useQuery();
  const optionsQuery = trpc.proxyInbounds.options.useQuery();
  const hostsQuery = trpc.hosts.list.useQuery();

  const refresh = () => {
    void utils.proxyInbounds.list.invalidate();
    // 派生节点会跟着变，订阅那边的列表和预览都要重取。
    void utils.proxySubscriptions.listNodes.invalidate();
    void utils.proxySubscriptions.preview.invalidate();
  };

  const createInbound = trpc.proxyInbounds.create.useMutation({
    onSuccess: () => {
      toast.success("落地节点已创建，配置正在下发");
      setDialogOpen(false);
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const updateInbound = trpc.proxyInbounds.update.useMutation({
    onSuccess: () => {
      toast.success("落地节点已更新，配置正在下发");
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
      toast.success("落地节点已删除");
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const hosts = (hostsQuery.data || []) as any[];
  const hostName = (hostId: number) => hosts.find((item) => Number(item.id) === Number(hostId))?.name || `主机 #${hostId}`;

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
    setForm({ ...emptyForm(), hostId: first ? Number(first.id) : 0 });
    setDialogOpen(true);
  };

  const openEdit = (row: any) => {
    setForm({
      id: Number(row.id),
      hostId: Number(row.hostId),
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
      obfs: String(row.obfs || ""),
      obfsPassword: String(row.obfsPassword || ""),
      snellVersion: Number(row.snellVersion || PROXY_INBOUND_SNELL_VERSIONS[0]),
      isEnabled: !!row.isEnabled,
    });
    setDialogOpen(true);
  };

  const submit = () => {
    if (!form.hostId) return toast.error("请选择一台主机");
    if (!form.name.trim()) return toast.error("请填写名称");
    const payload = {
      hostId: form.hostId,
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
      obfs: form.obfs.trim(),
      obfsPassword: form.obfsPassword.trim(),
      snellVersion: form.snellVersion,
      isEnabled: form.isEnabled,
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
      title: "删除落地节点？",
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
  const hasTransportOptions = transports.length > 1;
  const usesPath = form.transport === "ws" || form.transport === "grpc" || form.transport === "http";

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="text-base">落地节点</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                在自己的主机上开节点，自动进订阅。流量按端口计数，和转发规则走同一个套餐额度。租来的线路机装不了 Agent，那种仍然去「客户端订阅」粘链接。
              </p>
            </div>
            <Button size="sm" onClick={openCreate} disabled={hosts.length === 0}>
              <Plus className="mr-1 h-4 w-4" />
              新建
            </Button>
          </CardHeader>
          <CardContent>
            {inboundsQuery.isLoading ? (
              <DataSectionLoading />
            ) : rows.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                还没有落地节点。新建一个 REALITY 节点即可，它不需要域名和证书。
              </p>
            ) : (
              <div className="space-y-2">
                {rows.map((row) => (
                  <div key={row.id} className="flex flex-wrap items-center gap-2 rounded-md border p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">{row.name}</span>
                        <Badge variant="secondary" className="text-[10px]">
                          {PROXY_NODE_PROTOCOL_LABELS[row.protocol as ProxyNodeProtocol] || row.protocol}
                        </Badge>
                        {row.security !== "none" ? (
                          <Badge variant="outline" className="text-[10px]">
                            {PROXY_INBOUND_SECURITY_LABELS[row.security as ProxyInboundSecurity] || row.security}
                          </Badge>
                        ) : null}
                        {!row.isEnabled ? (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">已停用</Badge>
                        ) : null}
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        <Server className="mr-1 inline h-3 w-3" />
                        {hostName(Number(row.hostId))} · 端口 {row.port}
                        {row.transport && row.transport !== "tcp" ? ` · ${TRANSPORT_LABELS[row.transport] || row.transport}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" onClick={() => openEdit(row)} title="编辑">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => void askRotate(row)} title="重新生成凭据">
                        <KeyRound className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => void askDelete(row)} title="删除">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {hosts.length === 0 ? (
              <p className="mt-3 text-xs text-amber-600 dark:text-amber-500">
                还没有可用主机。落地节点要靠 Agent 下发配置，先去「主机管理」装一台。
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.id > 0 ? "编辑落地节点" : "新建落地节点"}</DialogTitle>
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
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={submit} disabled={saving}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
