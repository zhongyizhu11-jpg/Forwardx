import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/contexts/ThemeContext";
import { createHomepageDocument } from "@/lib/homepageHtml";
import { trpc } from "@/lib/trpc";
import { ArrowRight, ArrowUpRight, BookOpen, ChevronDown, Gauge, Moon, Network, Route, Server, ShieldCheck, Sun } from "lucide-react";
import { Link } from "wouter";
import { docsUrl } from "@/lib/docsLinks";

const features = [
  { title: "资源，一处掌握", text: "集中查看主机、线路与规则。先看到状态，再处理需要关注的问题。", icon: Server, detail: "主机 / 链路 / 规则" },
  { title: "路径，一目了然", text: "从入口到出口，清楚呈现每一跳。支持端口转发、隧道与转发链。", icon: Network, detail: "入口 → 中继 → 出口" },
  { title: "权限，各有边界", text: "管理员分配资源和套餐；用户在自己的工作空间内使用与管理。", icon: ShieldCheck, detail: "用户 / 资源 / 套餐" },
  { title: "用量，心中有数", text: "查看累计用量与近 24 小时趋势，掌握流量和套餐的使用情况。", icon: Gauge, detail: "流量 / 连接 / 有效期" },
];
const docsHomeUrl = docsUrl();
const journeys = {
  user: [
    ["登录工作空间", "使用已开通的账号登录，查看分配给你的资源和套餐。"],
    ["创建转发规则", "选择线路，填写入口端口和目标地址；规则名称可留空。"],
    ["查看连接与用量", "启用规则后，检查运行状态、连接次数和流量趋势。"],
  ],
  admin: [
    ["接入你的主机", "在主机管理中添加服务器，按安装指引连接 Agent。"],
    ["组织网络路径", "根据业务选择端口转发、隧道或多跳链路，配置入口与出口。"],
    ["分配并管理资源", "配置用户权限和套餐，在总览中持续关注运行状态。"],
  ],
};

export function CustomPublicHome({ html }: { html: string }) {
  return <iframe title="ForwardX 自定义首页" className="h-svh w-full border-0 bg-background"
    sandbox="allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation"
    srcDoc={createHomepageDocument(html)} />;
}

type PublicHomeViewProps = {
  siteTitle: string;
  logoSrc: string;
  version?: string;
  repoUrl?: string;
  registrationEnabled?: boolean;
  dark: boolean;
  onToggleTheme: () => void;
};

export function PublicHomeView({ siteTitle, logoSrc, version, repoUrl, registrationEnabled, dark, onToggleTheme }: PublicHomeViewProps) {
  const [journey, setJourney] = useState<"user" | "admin">("user");
  return (
    <div className="public-home-shell min-h-screen text-foreground">
      <a className="workspace-skip-link" href="#public-content">跳到主要内容</a>
      <header className="public-home-nav">
        <div className="public-home-container flex items-center justify-between gap-3 py-3">
          <Link href="/" className="flex min-w-0 items-center gap-3">
            <img src={logoSrc} alt="" className="h-8 w-8 shrink-0 object-contain" />
            <span className="truncate text-lg font-semibold">{siteTitle}</span>
          </Link>
          <nav aria-label="首页导航" className="flex shrink-0 items-center gap-2">
            <a href="#getting-started" className="public-nav-link hidden sm:inline-flex">如何开始</a>
            <a href={docsHomeUrl} className="public-nav-link hidden sm:inline-flex">使用文档<ArrowUpRight size={14} aria-hidden="true" /></a>
            <Button variant="ghost" size="icon" onClick={onToggleTheme} aria-label={dark ? "切换浅色模式" : "切换深色模式"}>
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
            <Button variant="outline" size="sm" asChild><Link href="/login">登录</Link></Button>
          </nav>
        </div>
      </header>
      <main id="public-content" tabIndex={-1}>
        <section className="public-home-hero">
          <div className="public-home-intro">
            <p className="hero-kicker"><span aria-hidden="true" /> FORWARDX · NETWORK WORKSPACE</p>
            <h1>复杂的网络，<br /><span>清晰地掌握。</span></h1>
            <p className="public-home-lead">让主机、线路与转发井然有序。<br />在 {siteTitle}，从一条清晰的路径开始。</p>
            <div className="flex flex-wrap gap-3">
              <Button size="lg" asChild><Link href={registrationEnabled === true ? "/login?mode=register" : "/login"}>{registrationEnabled === true ? "创建账号，开始使用" : "登录工作空间"}<ArrowRight className="ml-2 h-4 w-4" /></Link></Button>
              <a href="#getting-started" className="public-nav-link">了解使用流程<ArrowRight size={16} aria-hidden="true" /></a>
            </div>
            <p className="public-account-note">{registrationEnabled === false ? "当前未开放注册。需要账号或资源？请联系站点管理员。" : "已有账号？从右上角登录，继续你的工作。"}</p>
          </div>
          <figure className="public-network">
            <figcaption><span><Route size={16} aria-hidden="true" /> 一条清晰的路径</span><span>转发示意</span></figcaption>
            <div className="public-network-route">
              {[{icon:Server, title:"入口", detail:"接收连接"}, {icon:Network, title:"链路", detail:"传递流量"}, {icon:ArrowUpRight, title:"出口", detail:"到达目标"}].map(({icon:Icon,title,detail},index) => <div key={title} className="public-network-node">
                <span className="public-network-number">0{index + 1}</span><div className="public-network-node-icon"><Icon size={24} strokeWidth={1.5} aria-hidden="true" /></div>
                <strong>{title}</strong><small>{detail}</small>{index < 2 && <ArrowRight className="public-network-arrow" size={18} aria-hidden="true" />}
              </div>)}
            </div>
            <div className="public-network-foot"><span>路径清楚</span><span>状态可见</span><span>用量可查</span></div>
          </figure>
        </section>
        <section className="public-home-container public-section" aria-labelledby="home-features">
          <div className="public-section-heading">
            <div><p className="public-section-index">01 / 工作空间</p><h2 id="home-features">少一些切换，多一些掌握。</h2></div>
            <p>从配置到日常使用，<br />每一步都有清楚的去处。</p>
          </div>
          <div className="public-home-features">
            {features.map(({title, text, icon: Icon, detail}) => <article key={title}>
              <Icon size={22} strokeWidth={1.5} aria-hidden="true" />
              <div><h3>{title}</h3><p>{text}</p><small>{detail}</small></div>
            </article>)}
          </div>
        </section>
        <section id="getting-started" className="public-home-container public-section" aria-labelledby="home-start">
          <div className="public-section-heading">
            <div><p className="public-section-index">02 / 开始使用</p><h2 id="home-start">从你的角色出发。</h2></div>
            <div className="public-journey-switch" role="group" aria-label="选择使用方式">
              <button type="button" aria-pressed={journey === "user"} onClick={() => setJourney("user")}>使用服务</button>
              <button type="button" aria-pressed={journey === "admin"} onClick={() => setJourney("admin")}>管理网络</button>
            </div>
          </div>
          <ol className="public-journey" aria-live="polite">{journeys[journey].map(([title, text], index) => <li key={title}>
            <span>0{index + 1}</span><h3>{title}</h3><p>{text}</p>
          </li>)}</ol>
          <a href={docsHomeUrl} className="public-nav-link mt-5"><BookOpen size={16} aria-hidden="true" />查看完整操作指南<ArrowUpRight size={14} aria-hidden="true" /></a>
        </section>
        <section className="public-home-container public-section public-faq" aria-labelledby="home-faq">
          <div><p className="public-section-index">03 / 使用之前</p><h2 id="home-faq">先把疑问说清楚。</h2></div>
          <div>
            <details><summary>使用前需要准备什么？<ChevronDown size={16} aria-hidden="true" /></summary><p>使用服务需要一个账号、可用线路和目标地址。线路权限与套餐由站点管理员配置；管理自己的网络还需要可安装 Agent 的服务器。</p></details>
            <details><summary>如何获得账号和可用资源？<ChevronDown size={16} aria-hidden="true" /></summary><p>{registrationEnabled === true ? "本站已开放注册，可先创建账号。可用资源以登录后显示的权限和套餐为准。" : registrationEnabled === false ? "本站当前未开放自行注册，请联系站点管理员获取账号与资源权限。已有账号可直接登录。" : "可先登录已有账号。注册方式与资源权限以站点管理员的设置为准。"}</p></details>
            <details><summary>手机上可以完成管理吗？<ChevronDown size={16} aria-hidden="true" /></summary><p>可以。工作空间支持手机浏览器，在底部快捷导航切换常用页面，也可以通过搜索查找功能。入口端口、目标地址和规则状态都能在手机上查看与修改。</p></details>
          </div>
        </section>
      </main>
      <footer className="border-t bg-card">
        <div className="public-home-container flex flex-wrap items-center justify-between gap-3 py-5 text-xs text-muted-foreground">
          <span>{siteTitle} · {version ? `v${version}` : "Powered by ForwardX"}</span>
          <div className="flex items-center gap-4">
            {repoUrl && <a href={repoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center hover:text-foreground">GitHub</a>}
            <a href={docsHomeUrl} className="inline-flex min-h-11 items-center hover:text-foreground">使用文档</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default function PublicHome() {
  const { resolvedTheme, setTheme } = useTheme();
  const { data: info } = trpc.system.publicInfo.useQuery(undefined, { refetchOnWindowFocus: false });
  return <PublicHomeView
    siteTitle={(info?.siteTitle || "ForwardX").trim() || "ForwardX"}
    logoSrc={info?.siteLogoDataUrl || (resolvedTheme === "dark" ? "/logo-dark.png" : "/logo-light.png")}
    version={info?.version} repoUrl={info?.repoUrl}
    registrationEnabled={info ? info.registrationEnabled !== false : undefined}
    dark={resolvedTheme === "dark"} onToggleTheme={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
  />;
}
