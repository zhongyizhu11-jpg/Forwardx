import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LayoutDashboard, Server, Shield } from "lucide-react";
import { Router } from "wouter";
import { PublicHomeView } from "@/pages/PublicHome";
import SystemStatusHeader, { type SystemHealth } from "./SystemStatusHeader";
import { WorkspaceMobileNav } from "./WorkspaceNavigation";

const landingProps = { siteTitle: "示例站点", logoSrc: "/logo-light.png", dark: false, onToggleTheme: () => {} };

test("closed and unknown registration never advertise an actionable signup", () => {
  for (const registrationEnabled of [false, undefined]) {
    const html = renderToStaticMarkup(<Router ssrPath="/"><PublicHomeView {...landingProps} registrationEnabled={registrationEnabled} /></Router>);
    assert.doesNotMatch(html, /href="\/login\?mode=register"/);
    assert.match(html, /登录工作空间/);
    assert.match(html, /示例站点/);
  }
  const open = renderToStaticMarkup(<Router ssrPath="/"><PublicHomeView {...landingProps} registrationEnabled /></Router>);
  assert.match(open, /href="\/login\?mode=register"/);
});

test("mobile shortcuts use only supplied destinations and reserve a fifth slot for all navigation", () => {
  const items = [{ path: "/", label: "总览", icon: LayoutDashboard }, { path: "/hosts", label: "主机管理", icon: Server }];
  const render = (destinations: typeof items) => renderToStaticMarkup(<WorkspaceMobileNav items={destinations} currentPath="/hosts" onNavigate={() => {}} onMore={() => {}} />);
  const userHtml = render(items);
  assert.doesNotMatch(userHtml, /href="\/settings"|href="\/tunnels"/);
  assert.match(userHtml, /href="\/hosts" aria-current="page"/);
  const many = render([...items, ...Array.from({length: 5}, (_, i) => ({path: `/allowed-${i}`, label: `功能 ${i}`, icon: Shield}))]);
  assert.equal((many.match(/<a /g) || []).length, 4);
  assert.equal((many.match(/<button /g) || []).length, 1);
});

test("new, unavailable and healthy workspaces report distinct states", () => {
  const empty: SystemHealth = { hosts: {total:0,online:0,offline:0,neverConnected:0}, links: {total:0,healthy:0,unhealthy:0}, forwards: {total:0,running:0,stalled:0,disabled:0}, issues:0 };
  const newWorkspace = renderToStaticMarkup(<SystemStatusHeader isAdmin health={empty} />);
  assert.match(newWorkspace, /第一条连接/);
  assert.doesNotMatch(newWorkspace, /运行正常/);
  const unavailable = renderToStaticMarkup(<SystemStatusHeader isAdmin loading={false} onRetry={() => {}} />);
  assert.match(unavailable, /暂时无法读取状态/);
  assert.match(unavailable, /重新读取/);
  assert.doesNotMatch(unavailable, /检查中|运行正常/);
  const healthy = renderToStaticMarkup(<SystemStatusHeader isAdmin health={{...empty, hosts: {...empty.hosts, total:1, online:1}}} />);
  assert.match(healthy, /运行正常/);
});
