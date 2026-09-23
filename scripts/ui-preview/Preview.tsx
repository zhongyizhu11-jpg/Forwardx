import { useEffect, useState, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { Activity, ArrowRightLeft, BookOpen, Copy, Gift, LayoutDashboard, Link2, Moon, Network, Plus, Search, Server, Settings, ShieldCheck, Sun, Wallet, X } from "lucide-react";
import WorkspaceHeader from "@/components/WorkspaceHeader";
import ConnectionPath from "@/components/ConnectionPath";
import EntityGallery from "./EntityGallery";
import FilterToolbar from "@/components/FilterToolbar";
import TrafficOverview from "@/components/TrafficOverview";
import SystemStatusHeader, { type SystemHealth } from "@/components/SystemStatusHeader";
import { AttentionSection } from "@/features/dashboard/AttentionSection";
import { TrafficSurface, type TrafficChartPoint } from "@/features/dashboard/TrafficSurface";
import { emptyAttentionTotals } from "@shared/dashboardAttention";
import { SummaryStrip } from "@/components/entity/SummaryStrip";
import { CardActions } from "@/components/entity/EntityCard";
import { ListRow, ListSection } from "@/components/ios/GroupedList";
import EmptyState from "@/components/EmptyState";
import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import { WorkspaceCommand } from "@/components/WorkspaceNavigation";
import { PublicHomeView } from "@/pages/PublicHome";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormField } from "@/components/ui/form-field";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { SlidingTabsList } from "@/components/ui/sliding-tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import "@/index.css";
import "./preview.css";

/*
  总览页的示例数据。故意凑了一个「一台机器掉线牵连出一串」的场景：掉线主机、
  它上面没在跑的隧道、备线没了的转发组，外加一台还没装 Agent 的新机器 ——
  这几种状态在真实面板里很难同时凑齐，而「需要关注」要的正是它们排在一起的样子。
*/
const previewNow = Date.now();
const previewAttentionTotals = { ...emptyAttentionTotals(), "host-offline": 1, "tunnel-stopped": 1, "group-degraded": 1, "host-never-connected": 1 };
const previewHealth: SystemHealth = {
  hosts: { total: 5, online: 3, offline: 1, neverConnected: 1 },
  links: { total: 6, healthy: 4, unhealthy: 1, degraded: 1 },
  forwards: { total: 12, running: 12, stalled: 0, paused: 0, disabled: 0 },
  issues: 2,
  attention: {
    totals: previewAttentionTotals,
    rows: [
      { reason: "host-offline", id: 1, name: "US backup 04", at: previewNow - 18 * 60_000 },
      { reason: "tunnel-stopped", id: 2, name: "SG → US WSS", at: previewNow - 17 * 60_000, entryName: "SG relay 03", exitName: "US backup 04" },
      { reason: "group-degraded", id: 3, name: "Media failover", at: previewNow - 16 * 60_000, message: "SG 在用，US 备线不可用", groupMode: "failover" },
      { reason: "host-never-connected", id: 4, name: "新机器 · 东京", at: previewNow - 5 * 60_000 },
    ],
  },
};
const previewTraffic: TrafficChartPoint[] = Array.from({ length: 24 }, (_, index) => {
  const hour = new Date(previewNow - (23 - index) * 3_600_000);
  const label = `${String(hour.getHours()).padStart(2, "0")}:00`;
  const wave = 1 + Math.sin((index / 24) * Math.PI * 2 - 1.2) * 0.6;
  return { label, fullLabel: label, bytesIn: Math.round(wave * 1.9 * 1024 ** 3), bytesOut: Math.round(wave * 2.4 * 1024 ** 3) };
});
const previewBreakdown = {
  tunnelRules: [{ id: 11, name: "香港 → 东京 TLS", totalBytes: 38 * 1024 ** 3 }, { id: 12, name: "新加坡中转", totalBytes: 9 * 1024 ** 3 }],
  portRules: [{ id: 21, name: "游戏 TCP+UDP", totalBytes: 21 * 1024 ** 3 }, { id: 22, name: "网站 443", totalBytes: 4 * 1024 ** 3 }],
  forwardGroupRules: [{ id: 31, name: "API 主备", totalBytes: 15 * 1024 ** 3 }, { id: 32, name: "媒体主备", totalBytes: 2 * 1024 ** 3 }],
};

const sections = [
  {name:"总览", icon:LayoutDashboard}, {name:"网络语言",icon:Network}, {name:"转发规则",icon:ArrowRightLeft},
  {name:"链路管理",icon:Network}, {name:"账单与兑换",icon:Wallet},
  {name:"表单与状态",icon:Settings}, {name:"公开首页",icon:BookOpen},
];
const ruleTabs = [
  {value:"all",label:"全部",icon:LayoutDashboard,badge:3}, {value:"port",label:"端口转发",icon:ArrowRightLeft,badge:0},
  {value:"tunnel",label:"隧道转发",icon:Network,badge:3}, {value:"chain",label:"转发链",icon:Link2,badge:0}, {value:"group",label:"转发组",icon:ShieldCheck,badge:0},
];
const linkTabs = [
  {value:"tunnel",label:"隧道链路",icon:Network}, {value:"port",label:"端口转发",icon:ArrowRightLeft},
  {value:"chain",label:"转发链",icon:Link2}, {value:"group",label:"转发组",icon:ShieldCheck}, {value:"entry",label:"入口组"}, {value:"exit",label:"出口组"},
];
function SelectField({label, options}: {label:string;options:string[]}) {
  return <FormField className="space-y-2"><Label>{label}</Label><Select defaultValue={options[0]}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{options.map(x=><SelectItem key={x} value={x}>{x}</SelectItem>)}</SelectContent></Select></FormField>;
}
function Demo() {
  const [page,setPage] = useState("公开首页"), [dark,setDark] = useState(false), [tab,setTab] = useState("all");
  const [command,setCommand] = useState(false), [registration,setRegistration] = useState(true);
  const [query,setQuery]=useState(""),[dialog,setDialog]=useState(false),[nav,setNav]=useState(false),[redeem,setRedeem]=useState(true),[discount,setDiscount]=useState(true),[billingTab,setBillingTab]=useState("redeem");
  const [enabled,setEnabled]=useState<Record<string,boolean>>({}),[message,setMessage]=useState("");
  const toggleTheme=()=>{setDark(!dark);document.documentElement.classList.toggle("dark",!dark);};
  const logo=dark?(window as any).__PREVIEW_LOGO_DARK__:(window as any).__PREVIEW_LOGO__;
  const changePage=(name:string)=>{setPage(name);setNav(false);setTab(name==="链路管理"?"tunnel":"all");setQuery("");};
  const destinations=sections.map(({name,icon})=>({path:name,label:name,icon,group:"设计预览"}));
  const handlePublicLink = (event: MouseEvent<HTMLDivElement>) => {
    const href = (event.target as Element).closest("a")?.getAttribute("href");
    // A srcdoc document inherits its parent's base URL; keep fragment links in this preview.
    if (href?.startsWith("#")) {
      event.preventDefault(); event.stopPropagation();
      const target = document.getElementById(href.slice(1));
      target?.scrollIntoView({ block: "start" });
      if (target?.tabIndex === -1) target.focus({ preventScroll: true });
    } else if (href?.startsWith("/")) {
      event.preventDefault(); event.stopPropagation();
      setMessage("这是设计预览，登录与注册请在正式面板操作。");
    }
  };
  useEffect(()=>{
    if(page==="公开首页")return;
    const shortcut=(event:KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="k"&&!dialog){event.preventDefault();setCommand(value=>!value);}};
    window.addEventListener("keydown",shortcut);
    return ()=>window.removeEventListener("keydown",shortcut);
  },[page,dialog]);
  const names=page==="链路管理"?["华南 · 香港","华东 · 东京"]:["香港业务入口","东京备用入口","IPv6 业务入口"];
  const filtered=names.filter(x=>x.includes(query)&&["all","tunnel"].includes(tab));
  const createForm=<div className="space-y-5">
    <SelectField label="线路" options={["华南 · 香港","华东 · 东京"]}/>
    <FormField className="space-y-2"><Label>入口端口</Label><Input type="number" placeholder="例如 443" min={1} max={65535}/></FormField>
    <FormField className="space-y-2"><Label>目标地址</Label><Input placeholder="example.com:443" /></FormField>
    <FormField className="space-y-2"><Label>规则名称（选填）</Label><Input placeholder="留空时按目标地址生成" /></FormField>
  </div>;
  if(page==="公开首页")return <><div className="preview-return"><Button size="sm" variant="outline" onClick={()=>changePage("转发规则")}>查看工作台预览</Button><Button size="sm" variant="ghost" onClick={()=>setRegistration(value=>!value)}>模拟注册{registration?"关闭":"开放"}</Button><span role="status" className="text-xs text-muted-foreground">{message}</span></div><div onClickCapture={handlePublicLink}><PublicHomeView siteTitle="ForwardX" logoSrc={logo} repoUrl="https://github.com/zhongyizhu11-jpg/Forwardx" registrationEnabled={registration} dark={dark} onToggleTheme={toggleTheme}/></div></>;
  return <div className="workspace-layout preview-layout">
    <aside className={`preview-sidebar ${nav?"is-open":""}`}>
      <div className="preview-brand"><img src={logo} alt=""/><strong>ForwardX</strong><Button className="ml-auto md:hidden" variant="ghost" size="icon" onClick={()=>setNav(false)} aria-label="关闭导航"><X className="h-4 w-4"/></Button></div>
      <button className="workspace-nav-search mt-6" onClick={()=>{setNav(false);setCommand(true);}}><Search size={16}/><span>查找功能</span><kbd>⌘ / Ctrl K</kbd></button>
      <p className="px-3 pb-3 pt-6 text-xs text-muted-foreground">工作空间</p>
      <nav aria-label="设计预览导航" className="space-y-1">{sections.map(({name,icon:Icon})=><button key={name} data-sidebar="menu-button" data-active={page===name} onClick={()=>changePage(name)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm"><Icon className="h-4 w-4"/>{name}</button>)}</nav>
      <div className="mt-auto border-t pt-4 text-xs text-muted-foreground">统一设计 · 交互预览</div>
    </aside>
    <div className="workspace-with-mobile-nav min-w-0 flex-1">
      <header className="preview-topbar"><Button variant="ghost" size="icon" className="md:hidden" onClick={()=>setNav(!nav)} aria-label="打开导航"><LayoutDashboard className="h-5 w-5"/></Button><span className="min-w-0 truncate text-sm text-muted-foreground"><span className="hidden sm:inline">工作空间 <span className="mx-2 text-border">/</span></span><span className="text-foreground">{page}</span></span><Button variant="ghost" size="icon" onClick={()=>setCommand(true)} aria-label="查找功能" className="ml-auto"><Search size={16}/></Button><Button variant="ghost" size="icon" onClick={toggleTheme} aria-label={dark?"切换浅色模式":"切换深色模式"}>{dark?<Sun className="h-4 w-4"/>:<Moon className="h-4 w-4"/>}</Button></header>
      <main id="workspace-content" tabIndex={-1} className="workspace-main space-y-6 p-4 sm:p-6 lg:p-8">
        {page==="网络语言"?<>
          <WorkspaceHeader title="网络语言" description="业务实体在各种状态下的样子。这一页是视觉回归的基准 —— 真实面板里难得把离线主机、降级链路、正在切换的线路凑齐。"/>
          <EntityGallery/>
        </>:page==="总览"?<>
          <WorkspaceHeader title="总览" description="查看运行状态、资源使用和流量趋势。" />
          <SystemStatusHeader isAdmin health={previewHealth}/>
          <AttentionSection isAdmin attention={previewHealth.attention} onOpen={()=>{}} now={previewNow}/>
          <TrafficSurface recentBytes={previewTraffic.reduce((sum,point)=>sum+point.bytesIn+point.bytesOut,0)} chartData={previewTraffic} chartLoading={false} breakdown={previewBreakdown} breakdownLoading={false} totals={{totalTrafficIn:1.69*1024**4,totalTrafficOut:1.74*1024**4}} totalsLoading={false}/>
        </>:page==="转发规则"||page==="链路管理"?<>
          <WorkspaceHeader title={page} description={page==="链路管理"?"管理隧道、端口转发、转发链及入口/出口组":"管理转发规则和运行状态"}
            status={<Badge variant="outline"><Activity className="mr-1 h-3 w-3"/>{page==="链路管理"?"2 / 2 可用":"3 / 3 已启用"}</Badge>}
            actions={<Button onClick={()=>setDialog(true)} className="gap-2"><Plus className="h-4 w-4"/>{page==="链路管理"?"新建链路":"新建规则"}</Button>}/>
          {page==="转发规则"&&<TrafficOverview total={{bytesIn:1148900000,bytesOut:11124000000,connections:61794}} daily={{bytesIn:111620000,bytesOut:1664300000,connections:7248}} totalLoading={false} dailyLoading={false} scope="preview" lastScope="preview"/>}
          <Tabs value={tab} onValueChange={setTab} className="space-y-4">
            <SlidingTabsList items={page==="链路管理"?linkTabs:ruleTabs} activeValue={tab} ariaLabel="资源分类"/>
            <FilterToolbar search={<div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground"/><Input aria-label="搜索资源" placeholder="搜索名称、主机或 IP" value={query} onChange={e=>setQuery(e.target.value)} className="pl-9"/></div>}>
              <Select defaultValue="全部用户"><SelectTrigger aria-label="用户筛选"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="全部用户">全部用户</SelectItem><SelectItem value="我的规则">我的规则</SelectItem></SelectContent></Select>
              <Select defaultValue="全部隧道"><SelectTrigger aria-label="线路筛选"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="全部隧道">全部隧道</SelectItem><SelectItem value="华南 · 香港">华南 · 香港</SelectItem></SelectContent></Select>
            </FilterToolbar>
            {filtered.length===0?<Card><EmptyState icon={<Search/>} title="没有匹配的资源" description="调整分类或搜索条件后重试。" actions={<Button variant="outline" onClick={()=>{setTab("tunnel");setQuery("");}}>清除筛选</Button>}/></Card>:<div className="grid gap-4 lg:grid-cols-2">{filtered.map((name,index)=><Card key={name} className="action-card"><CardContent className="action-card-content space-y-4 p-4">
              <div className="flex items-start justify-between gap-3"><div><h2 className="text-base font-semibold">{name}</h2><p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"><span className={`h-1.5 w-1.5 rounded-full ${enabled[name]===false?"bg-muted-foreground":"bg-emerald-600"}`}/>{enabled[name]===false?"已停用":"运行正常"}<span>·</span>ForwardX</p></div><Switch checked={enabled[name]!==false} onCheckedChange={v=>setEnabled({...enabled,[name]:v})} aria-label={`启用${name}`}/></div>
              <ConnectionPath steps={page==="链路管理"?[{key:"entry",label:"入口",content:<strong className="font-medium">华南入口</strong>},{key:"exit",label:"出口",content:<strong className="font-medium">{index===0?"香港出口":"东京出口"}</strong>}]:[{key:"entry",label:"入口 · 点击复制",content:<button className="flex w-full items-start justify-between gap-2 text-left" onClick={()=>setMessage("演示：地址已复制")}><code className="break-all">{index===2?"[2001:db8:85a3:0000:0000:8a2e:0370:7334]:443":"203.0.113.10:44760"}</code><Copy className="h-4 w-4 shrink-0"/></button>},{key:"exit",label:"目标地址",content:<code>service.example.com:443</code>}]}/>
              <div className="flex items-center justify-between gap-2"><Badge variant="secondary">TCP + UDP</Badge><span className="text-xs text-muted-foreground">延迟 <strong className="ml-1 font-medium text-foreground">23 ms</strong></span></div>
              <CardActions><Button variant="ghost" size="sm" onClick={()=>setDialog(true)}>编辑</Button><Button variant="ghost" size="sm" onClick={()=>setMessage("演示：线路连通，23 ms")}>测试连接</Button></CardActions>
            </CardContent></Card>)}</div>}
          </Tabs>
        </>:page==="账单与兑换"?<>
          <WorkspaceHeader title="账单与兑换" description="查看收支流水，管理兑换码与折扣码。"/>
          <SummaryStrip ariaLabel="账单概况" items={[["累计收入","¥ 1,280.00"],["生效订阅","24"],["可用兑换码","12"]].map(([title,value])=>({key:title,label:title,value,cacheKey:`preview.${title}`}))}/>
          <ListSection header="用户入口">{[["用户兑换入口",redeem,setRedeem],["购买折扣入口",discount,setDiscount]].map(([title,on,set])=><ListRow key={String(title)} icon={<Gift className="h-4 w-4"/>} label={String(title)} detail={on?"已开启 · 用户可使用":"已关闭 · 用户不可使用"} trailing={<Switch aria-label={String(title)} checked={Boolean(on)} onCheckedChange={set as (value:boolean)=>void}/>}/>)}</ListSection>
          <Tabs value={billingTab} onValueChange={setBillingTab} className="space-y-4"><SlidingTabsList items={[{value:"bills",label:"账单流水"},{value:"subscriptions",label:"订阅记录"},{value:"balance",label:"余额流水"},{value:"redeem",label:"兑换码"},{value:"discount",label:"折扣码"}]} activeValue={billingTab} ariaLabel="账单分类"/>
            <TabsContent value="redeem"><Card><CardHeader><CardTitle>生成兑换码</CardTitle><CardDescription>一次性兑换套餐或余额。</CardDescription></CardHeader><CardContent className="space-y-5"><FormField className="space-y-2"><Label>兑换码（选填）</Label><Input placeholder="留空自动生成" /></FormField><SelectField label="类型" options={["余额","套餐"]}/><FormField className="space-y-2"><Label>金额（元）</Label><Input type="number" placeholder="0.00" min={0}/></FormField><div className="border-t pt-4"><Button onClick={()=>setMessage("演示预览不会生成实际兑换码")}>生成兑换码</Button></div></CardContent></Card></TabsContent>
            {billingTab!=="redeem"&&<Card><EmptyState icon={<Wallet/>} title="暂无记录" description="业务发生后，流水会显示在这里。"/></Card>}
          </Tabs>
        </>:<>
          <WorkspaceHeader title="表单与状态" description="表单、弹窗、空列表及异常提示使用相同的布局规则。" actions={<Button onClick={()=>setDialog(true)}>打开表单</Button>}/>
          <div className="grid gap-4 lg:grid-cols-2"><Card><CardHeader><CardTitle>创建转发规则</CardTitle><CardDescription>按线路、端口、目标地址的顺序填写。</CardDescription></CardHeader><CardContent>{createForm}</CardContent></Card><div className="space-y-4"><Card><EmptyState icon={<Server/>} title="暂无主机" description="添加第一台主机，获取 Agent 安装命令。" actions={<Button onClick={()=>setDialog(true)}>添加主机</Button>}/></Card><DataSectionLoading label="主机列表"/><DataSectionError label="连接记录" onRetry={()=>setMessage("演示：已重试")}/></div></div>
        </>}
        <p role="status" className="text-sm text-muted-foreground">{message}</p>
      </main>
    </div>
    <WorkspaceCommand open={command} onOpenChange={setCommand} items={destinations} currentPath={page} onNavigate={item=>changePage(item.path)}/>
    <Dialog open={dialog} onOpenChange={setDialog}><DialogContent><DialogHeader><DialogTitle>创建转发规则</DialogTitle><DialogDescription>先选择线路，再设置入口端口与目标地址。</DialogDescription></DialogHeader>{createForm}<DialogFooter><Button variant="outline" onClick={()=>setDialog(false)}>取消</Button><Button onClick={()=>{setDialog(false);setMessage("演示预览不会创建实际资源");}}>完成预览</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Demo/>);
