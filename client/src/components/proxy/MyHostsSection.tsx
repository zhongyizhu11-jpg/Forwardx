import { useAuth } from "@/_core/hooks/useAuth";
import DataSectionLoading from "@/components/DataSectionLoading";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProxyNodeRow, proxyNodeMetaText } from "@/components/proxy/ProxyNodeRow";
import { clipboardNeedsManualCopy, copyTextFromElement } from "@/lib/clipboard";
import { trpc } from "@/lib/trpc";
import { ChevronDown, Plus, Server, Terminal, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

/**
 * 「我的机器」——租户自己加机器、拿 Agent 安装命令、看在不在线。
 *
 * 为什么不直接把「主机管理」那一页放开：那页三千多行、近二十个接口，好几个是
 * adminProcedure（分组、DDNS、批量升级、流量校准……），整页放开只会让租户到处
 * 撞权限错。他要的其实只有三件事 —— 加一台、拿到安装命令、知道连上没有 ——
 * 所以在这里做一个够用的小入口，放在「新建节点」上面：先有机器，才谈得上在
 * 上面开节点。
 *
 * 后端本来就支持：hosts.create 是 protectedProcedure，建出来的主机 userId 就是
 * 他自己，管理员那些字段（流量告警、DDNS、封禁开关）对非管理员一律落成默认值。
 * 缺的只是一个入口，和一条他拿得到的安装命令。
 *
 * 能开几个节点仍由 maxProxyInbounds 管着 —— 机器行本身不消耗任何东西，Agent
 * 没连上的行就是一条死记录。
 */
export default function MyHostsSection() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();

  const [collapsed, setCollapsed] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ name: "", ip: "" });
  const [commandHostId, setCommandHostId] = useState(0);
  const commandRef = useRef<HTMLParagraphElement | null>(null);

  const isAdmin = user?.role === "admin";
  const hostsQuery = trpc.hosts.list.useQuery(undefined, { enabled: !isAdmin });
  // 额度先摆出来，别等人填完表单才弹一句「已达上限」。
  const quotaQuery = trpc.hosts.selfServiceQuota.useQuery(undefined, { enabled: !isAdmin });
  const commandQuery = trpc.hosts.agentInstallCommand.useQuery(
    { hostId: commandHostId },
    { enabled: commandHostId > 0 },
  );

  const invalidate = () => {
    utils.hosts.list.invalidate();
    utils.hosts.selfServiceQuota.invalidate();
    // 「新建节点」的主机下拉走的是 options，不刷的话新加的机器要等下次进页面才出现。
    utils.hosts.options.invalidate();
  };

  const createHost = trpc.hosts.create.useMutation({
    onSuccess: (result: any) => {
      invalidate();
      setAddOpen(false);
      setForm({ name: "", ip: "" });
      // 直接把安装命令摆出来：加完机器不装 Agent，这条记录就是个空壳。
      setCommandHostId(Number(result?.id || 0));
      toast.success("机器已添加，接着在它上面装 Agent");
    },
    onError: (error) => toast.error(error.message || "添加失败"),
  });

  const deleteHost = trpc.hosts.delete.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success("已删除");
    },
    onError: (error) => toast.error(error.message || "删除失败"),
  });

  // 管理员有整页的「主机管理」，这里再放一个精简版只是噪音。
  if (isAdmin) return null;

  const myHosts = ((hostsQuery.data || []) as any[]).filter(
    (host) => Number(host?.userId || 0) === Number(user?.id || 0),
  );
  const onlineCount = myHosts.filter((host) => !!host.isOnline).length;
  const quotaLimit = Number(quotaQuery.data?.limit || 0);
  const canAddHost = quotaQuery.data ? !!quotaQuery.data.canAdd : true;

  const save = () => {
    const name = form.name.trim();
    const ip = form.ip.trim();
    if (!name) return toast.error("给机器起个名字");
    if (!ip) return toast.error("填上机器的 IP 或域名");
    createHost.mutate({ name, ip });
  };

  const askDelete = async (host: any) => {
    const ok = await confirm({
      title: "删除这台机器？",
      description: `面板不再管「${host.name}」。机器上的 Agent 不会自己卸载，要连服务器执行卸载命令才算干净。`,
      confirmText: "删除",
      tone: "destructive",
    });
    if (ok) deleteHost.mutate({ id: Number(host.id) });
  };

  const commandText = commandQuery.data?.command || "";
  const panelUrlMissing = !!commandQuery.data && !commandQuery.data.panelUrl;

  return (
    <>
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
            <CardTitle className="text-base">我的机器</CardTitle>
            {myHosts.length > 0 ? (
              <span className="truncate text-xs text-muted-foreground">
                {quotaLimit > 0 ? `${myHosts.length}/${quotaLimit} 台` : `${myHosts.length} 台`}
                {onlineCount > 0 ? ` · ${onlineCount} 在线` : ""}
              </span>
            ) : null}
          </button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canAddHost}
            title={canAddHost ? undefined : `自己添加的机器已达上限（${quotaLimit} 台），删掉一台，或让管理员调高上限`}
            onClick={() => setAddOpen(true)}
          >
            <Plus className="mr-1 h-4 w-4" />
            加一台
          </Button>
        </CardHeader>
        <CardContent hidden={collapsed} className="pt-0">
          {hostsQuery.isLoading ? (
            <DataSectionLoading />
          ) : myHosts.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              还没有自己的机器。加一台之后，把它给出的命令粘进那台机器的 SSH 装上 Agent，就能在上面开自己的节点。
            </p>
          ) : (
            <div className="space-y-1.5">
              {myHosts.map((host) => (
                <ProxyNodeRow
                  key={host.id}
                  leading={
                    <span
                      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${host.isOnline ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                      title={host.isOnline ? "Agent 已连上面板" : "Agent 还没连上面板"}
                      aria-label={host.isOnline ? "在线" : "离线"}
                    />
                  }
                  name={host.name}
                  meta={proxyNodeMetaText([
                    host.ip,
                    host.isOnline ? "在线" : "离线",
                    host.agentVersion ? `Agent ${host.agentVersion}` : "还没装 Agent",
                  ])}
                  actions={[
                    {
                      key: "command",
                      label: "安装命令",
                      icon: Terminal,
                      onSelect: () => setCommandHostId(Number(host.id)),
                    },
                    {
                      key: "delete",
                      label: "删除",
                      icon: Trash2,
                      destructive: true,
                      onSelect: () => void askDelete(host),
                    },
                  ]}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>加一台机器</DialogTitle>
            <DialogDescription>
              填个名字和地址就行。加完会给你一条安装命令，在那台机器上执行，它才会连上面板。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">名称</Label>
              <Input
                value={form.name}
                onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="我的 HK 小鸡"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">IP 或域名</Label>
              <Input
                value={form.ip}
                onChange={(event) => setForm((prev) => ({ ...prev, ip: event.target.value }))}
                placeholder="1.2.3.4"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>取消</Button>
            <Button onClick={save} disabled={createHost.isPending}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={commandHostId > 0} onOpenChange={(open) => !open && setCommandHostId(0)}>
        <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Agent 安装命令</DialogTitle>
            <DialogDescription>
              用 root 连上那台机器，把下面这条整行粘进去执行。装好后这里的圆点会变绿。
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {commandQuery.isLoading ? (
              <DataSectionLoading />
            ) : panelUrlMissing ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                面板还没配公开地址，装上的 Agent 不知道该回连到哪里。请联系管理员在「系统设置」里配好面板地址，再回来取命令。
              </p>
            ) : (
              <>
                {/* select-all + break-all：一键复制失败时要能一下选中整条。 */}
                <p
                  ref={commandRef}
                  className="select-all break-all rounded-md border bg-muted/30 p-2.5 font-mono text-[11px] leading-relaxed"
                >
                  {commandText}
                </p>
                {clipboardNeedsManualCopy() ? (
                  <p className="pt-2 text-xs text-muted-foreground">
                    当前是 http 访问，没有剪贴板 API，只能走旧办法，有些浏览器（iOS 尤其）会拒绝。
                    一键复制不成时，长按上面这段选中即可。
                  </p>
                ) : null}
                <p className="pt-2 text-xs text-amber-600 dark:text-amber-500">
                  命令里带着这台机器的 Agent 令牌，谁拿到谁就能把机器接进面板，别转发给别人。
                </p>
              </>
            )}
          </div>
          <DialogFooter className="shrink-0 border-t pt-3">
            <Button variant="outline" onClick={() => setCommandHostId(0)}>关闭</Button>
            <Button
              disabled={!commandText}
              onClick={async () => {
                const ok = await copyTextFromElement(commandRef.current, commandText);
                if (ok) toast.success("命令已复制");
                // 失败时选区还留着，直接用系统菜单复制就行。
                else toast.error("浏览器拒绝了复制，命令已选中，用系统菜单复制即可");
              }}
            >
              复制命令
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
