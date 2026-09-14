import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmDialogProvider } from "@/components/ui/confirm-dialog";
import { useAuth } from "@/_core/hooks/useAuth";
import type { ComponentType } from "react";
import { trpc } from "@/lib/trpc";
import { mobileAuth } from "@/lib/mobileAuth";
import NotFound from "@/pages/NotFound";
import { Redirect, Route, Switch, useLocation } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import PersonalizationLayer from "./components/PersonalizationLayer";
import Live2DWidgetHost from "./components/plugins/Live2DWidgetHost";
import Setup from "./pages/Setup";
import AnnouncementsPage from "@/pages/Announcements";
import BillingPage from "@/pages/Billing";
import CustomSidebarPage from "@/pages/CustomSidebarPage";
import EmailSettingsPage from "@/pages/EmailSettings";
import ForwardGroupsPage from "@/pages/ForwardGroups";
import HomePage from "@/pages/Home";
import HomepagePreviewPage from "@/pages/HomepagePreview";
import HostMonitorPage from "@/pages/HostMonitor";
import HostsPage from "@/pages/Hosts";
import LoginPage from "@/pages/Login";
import LookingGlassPage from "@/pages/LookingGlass";
import PaymentsPage from "@/pages/Payments";
import PlansPage from "@/pages/Plans";
import PluginsPage from "@/pages/Plugins";
import ProfilePage from "@/pages/Profile";
import RulesPage from "@/pages/Rules";
import SettingsPage from "@/pages/Settings";
import StorePage from "@/pages/Store";
import SubscriptionsPage from "@/pages/Subscriptions";
import ClientSubscriptionsPage from "@/pages/ClientSubscriptions";
import ProxyInboundsPage from "@/pages/ProxyInbounds";
import TrafficBillingPage from "@/pages/TrafficBilling";
import TunnelsPage from "@/pages/Tunnels";
import UsersPage from "@/pages/Users";
import WalletPage from "@/pages/Wallet";

type RoutableComponent = ComponentType<any>;

function routeComponent(Component: RoutableComponent) {
  return () => <Component />;
}

function isLoginRoute(location: string) {
  return location.startsWith("/login");
}

const isLocalDevPanel = (import.meta as any).env?.VITE_FORWARDX_DEV_PANEL === "1";

function AdminRoute({ component: Component }: { component: RoutableComponent }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Redirect to="/login" />;
  if (user.role !== "admin") return <Redirect to="/" />;
  return <Component />;
}

function LookingGlassRoute() {
  const { user, loading } = useAuth();
  const publicInfo = trpc.system.publicInfo.useQuery(undefined, {
    enabled: !!user,
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (loading) return null;
  if (user && publicInfo.isLoading && !publicInfo.data) return null;
  if (!user) return <Redirect to="/login" />;
  if (user.role !== "admin" && publicInfo.data?.lookingGlassUserEnabled !== true) return <Redirect to="/" />;
  return <LookingGlassPage />;
}

function PluginsRoute({ sidebarPluginId }: { sidebarPluginId?: string }) {
  const { user, loading } = useAuth();
  const publicInfo = trpc.system.publicInfo.useQuery(undefined, {
    enabled: !!user,
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (loading) return null;
  if (!user) return <Redirect to="/login" />;
  if (user.role !== "admin") return <Redirect to="/" />;
  if (publicInfo.isLoading && !publicInfo.data) return <PluginsPage sidebarPluginId={sidebarPluginId} />;
  if (publicInfo.data?.pluginsEnabled !== true) return <Redirect to="/settings" />;
  return <PluginsPage sidebarPluginId={sidebarPluginId} />;
}

function Router() {
  return (
    <Switch>
      <Route path="/setup" component={Setup} />
      <Route path="/login">{routeComponent(LoginPage)}</Route>
      <Route path="/session-wait"><Redirect to="/login" /></Route>
      <Route path="/homepage-preview">{routeComponent(HomepagePreviewPage)}</Route>
      <Route path="/">{routeComponent(HomePage)}</Route>
      <Route path="/profile">{routeComponent(ProfilePage)}</Route>
      {/*
        主机管理对租户也开放：他能自助加机器，就得有个地方看这些机器的状况
        （CPU、内存、磁盘、流量、在不在线）。页面按角色收口 —— 服务端只给他
        自己的机器（listPage 的 ownedOnly），分组/Token 两个 tab 和 Agent 升级、
        重置流量这些管理员专属的入口都不渲染。
      */}
      <Route path="/hosts">{routeComponent(HostsPage)}</Route>
      <Route path="/rules">{routeComponent(RulesPage)}</Route>
      <Route path="/looking-glass" component={LookingGlassRoute} />
      <Route path="/forward-groups">{() => <AdminRoute component={ForwardGroupsPage} />}</Route>
      <Route path="/tunnels">{() => <AdminRoute component={TunnelsPage} />}</Route>
      <Route path="/users">{() => <AdminRoute component={UsersPage} />}</Route>
      <Route path="/email-settings">{() => <AdminRoute component={EmailSettingsPage} />}</Route>
      <Route path="/payments">{() => <AdminRoute component={PaymentsPage} />}</Route>
      <Route path="/billing">{() => <AdminRoute component={BillingPage} />}</Route>
      <Route path="/traffic-billing">{() => <AdminRoute component={TrafficBillingPage} />}</Route>
      <Route path="/plans">{() => <AdminRoute component={PlansPage} />}</Route>
      <Route path="/plugins/sidebar/:pluginId">
        {(params) => <PluginsRoute sidebarPluginId={params.pluginId} />}
      </Route>
      <Route path="/plugins">{() => <PluginsRoute />}</Route>
      <Route path="/store">{routeComponent(StorePage)}</Route>
      <Route path="/subscriptions">{routeComponent(SubscriptionsPage)}</Route>
      <Route path="/client-subscriptions">{routeComponent(ClientSubscriptionsPage)}</Route>
      <Route path="/proxy-inbounds">{routeComponent(ProxyInboundsPage)}</Route>
      <Route path="/wallet">{routeComponent(WalletPage)}</Route>
      <Route path="/announcements">{routeComponent(AnnouncementsPage)}</Route>
      <Route path="/settings">{() => <AdminRoute component={SettingsPage} />}</Route>
      <Route path="/custom-pages/:pageId">
        {(params) => <CustomSidebarPage pageId={params.pageId} />}
      </Route>
      <Route path="/404" component={NotFound} />
      <Route path="/:monitorPath">{routeComponent(HostMonitorPage)}</Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function SetupGate() {
  const [location] = useLocation();
  const hasMobilePanelUrl = !mobileAuth.isNative || mobileAuth.hasPanelUrl();
  const loginRoute = isLoginRoute(location);

  // Keep this hook unconditional.  Local development redirects /login to the
  // seeded dashboard, and returning before the query here makes the hook list
  // change when the redirect completes.
  const setup = trpc.setup.status.useQuery(undefined, {
    enabled: hasMobilePanelUrl && !loginRoute,
    retry: false,
    refetchOnWindowFocus: false,
  });

  // The local dev panel injects the seeded administrator in the server
  // context, so showing a login form here only creates a needless gate.
  if (isLocalDevPanel && (loginRoute || location === "/session-wait")) {
    return <Redirect to="/" />;
  }

  if (!hasMobilePanelUrl) {
    if (location !== "/login") return <Redirect to="/login" />;
    return <Router />;
  }

  if (loginRoute) return <Router />;

  if (setup.isError) {
    if (mobileAuth.isNative) {
      if (location !== "/login") return <Redirect to="/login" />;
      return <Router />;
    }
    return <Router />;
  }

  if (setup.isLoading) return null;

  const ready = !!setup.data?.setupComplete;
  if (!ready && location !== "/setup") return <Redirect to="/setup" />;
  if (ready && location === "/setup") return <Redirect to="/login" />;
  return <Router />;
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <ConfirmDialogProvider>
            <PersonalizationLayer />
            <Live2DWidgetHost />
            <Toaster />
            <SetupGate />
          </ConfirmDialogProvider>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
