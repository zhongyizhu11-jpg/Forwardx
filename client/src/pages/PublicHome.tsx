import ConnectionPath from "@/components/ConnectionPath";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/contexts/ThemeContext";
import { createHomepageDocument } from "@/lib/homepageHtml";
import { trpc } from "@/lib/trpc";
import { ArrowRight, BookOpen, Gauge, Moon, Network, Server, ShieldCheck, Sun } from "lucide-react";
import { toast } from "sonner";
import { Link } from "wouter";

const features = [
  { title: "主机管理", text: "接入 Agent，集中查看服务器状态与版本。", icon: Server },
  { title: "链路与转发", text: "配置 TCP、UDP、隧道和多跳转发路径。", icon: Network },
  { title: "权限与套餐", text: "按用户分配资源、流量和使用期限。", icon: ShieldCheck },
  { title: "流量与提醒", text: "查看流量趋势，接收临期和额度提醒。", icon: Gauge },
];

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
  registrationEnabled: boolean;
  dark: boolean;
  onToggleTheme: () => void;
};

export function PublicHomeView({ siteTitle, logoSrc, version, repoUrl, registrationEnabled, dark, onToggleTheme }: PublicHomeViewProps) {
  const handleRegisterClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (registrationEnabled) return;
    event.preventDefault();
    toast.info("当前注册未开放，请联系管理员");
  };
  return (
    <div className="public-home-shell min-h-screen text-foreground">
      <header className="public-home-nav">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <Link href="/" className="flex min-w-0 items-center gap-3">
            <img src={logoSrc} alt="" className="h-8 w-8 shrink-0 object-contain" />
            <span className="truncate text-lg font-semibold">{siteTitle}</span>
          </Link>
          <nav aria-label="首页导航" className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="icon" onClick={onToggleTheme} aria-label={dark ? "切换浅色模式" : "切换深色模式"}>
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
            <Button variant="outline" size="sm" asChild><Link href="/login">登录</Link></Button>
          </nav>
        </div>
      </header>
      <main>
        <section className="public-home-hero">
          <div className="space-y-6">
            <p className="hero-kicker">FORWARDX · 网络控制台</p>
            <h1>让每一条转发<br />都有清晰的路径。</h1>
            <p className="max-w-lg text-base leading-7 text-muted-foreground">从主机接入到链路配置，在 {siteTitle} 统一管理转发、用户和流量。</p>
            <div className="flex flex-wrap gap-3">
              <Button size="lg" asChild><Link href="/login">进入控制台<ArrowRight className="ml-2 h-4 w-4" /></Link></Button>
              <Button size="lg" variant="outline" asChild><Link href="/login?mode=register" onClick={handleRegisterClick}>创建账号</Link></Button>
            </div>
            <a href="https://zhongyizhu11-jpg.github.io/Forwardx/" className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              <BookOpen className="h-4 w-4" />第一次使用？查看部署与使用指南
            </a>
          </div>
          <div className="public-home-diagram">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">从接入到交付</h2>
              <span className="text-xs text-muted-foreground">配置流程</span>
            </div>
            <ConnectionPath steps={[
              { key: "host", label: "01 · 接入主机", content: <><strong className="font-medium">安装 Agent</strong><p className="text-xs text-muted-foreground">连接并管理 Linux 服务器</p></> },
              { key: "link", label: "02 · 组织链路", content: <><strong className="font-medium">选择入口、中继与出口</strong><p className="text-xs text-muted-foreground">构建端口、隧道或多跳路径</p></> },
              { key: "rule", label: "03 · 创建转发", content: <><strong className="font-medium">设置端口与目标地址</strong><p className="text-xs text-muted-foreground">启用规则，查看连接与流量</p></> },
            ]} />
          </div>
        </section>
        <section className="mx-auto max-w-6xl px-4 pb-12 sm:px-6 sm:pb-16" aria-labelledby="home-features">
          <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="home-features" className="text-xl font-semibold tracking-tight">一个工作台，管理整个网络</h2>
            <span className="text-xs text-muted-foreground">主机 · 链路 · 用户 · 流量</span>
          </div>
          <div className="public-home-features">
            {features.map(({title, text, icon: Icon}) => <article key={title} className="rounded-xl border bg-card p-5 shadow-sm">
              <div className="stat-card-icon"><Icon className="h-4 w-4" /></div>
              <h3 className="mt-4 text-sm font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{text}</p>
            </article>)}
          </div>
        </section>
      </main>
      <footer className="border-t bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-5 text-xs text-muted-foreground sm:px-6">
          <span>ForwardX · {version ? `v${version}` : "转发管理面板"}</span>
          <div className="flex items-center gap-4">
            {repoUrl && <a href={repoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center hover:text-foreground">GitHub</a>}
            <a href="https://zhongyizhu11-jpg.github.io/Forwardx/" className="inline-flex min-h-11 items-center hover:text-foreground">使用文档</a>
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
    registrationEnabled={info?.registrationEnabled !== false}
    dark={resolvedTheme === "dark"} onToggleTheme={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
  />;
}
