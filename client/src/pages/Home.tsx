import WorkspaceHeader from "@/components/WorkspaceHeader";
import { useAuth } from "@/_core/hooks/useAuth";
import { quotaSourceLabel } from "@shared/ledgerLabels";
import { formatMoneyCents as money } from "@shared/formatMoney";
import { formatBytes } from "@shared/formatBytes";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import DashboardLayout from "@/components/DashboardLayout";
import MobileAppSettings from "@/components/MobileAppSettings";
import SystemStatusHeader, { type SystemHealth } from "@/components/SystemStatusHeader";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { mobileAuth } from "@/lib/mobileAuth";
import { pollingInterval } from "@/lib/polling";
import { trafficQuotaBreakdown } from "@/lib/trafficQuota";
import { trpc } from "@/lib/trpc";
import { AttentionSection } from "@/features/dashboard/AttentionSection";
import { TrafficSurface, type TrafficChartPoint } from "@/features/dashboard/TrafficSurface";
import {
  Activity,
  Coins,
  Package,
  Shield,
  WalletCards,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import PublicHome, { CustomPublicHome } from "./PublicHome";

const LOGIN_WELCOME_TOAST_KEY = "forwardx.loginWelcome";

function formatTrafficTime(value: string | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hour}:${minute}`;
}

function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "永久有效";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "永久有效" : date.toLocaleDateString("zh-CN");
}

function getExpiryStatus(value: string | Date | null | undefined) {
  if (!value) return { label: "永久有效", tone: "normal" as const };
  const expiry = new Date(value).getTime();
  if (Number.isNaN(expiry)) return { label: "永久有效", tone: "normal" as const };
  const diffDays = Math.ceil((expiry - Date.now()) / 86_400_000);
  if (diffDays < 0) return { label: "已到期", tone: "danger" as const };
  if (diffDays <= 7) return { label: diffDays === 0 ? "今日到期" : `剩余 ${diffDays} 天`, tone: "warning" as const };
  return { label: `剩余 ${diffDays} 天`, tone: "normal" as const };
}

function DashboardContent() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [, setLocation] = useLocation();
  const { data: trafficTotals, isLoading: trafficTotalsLoading } = trpc.dashboard.trafficTotals.useQuery(undefined, {
    refetchInterval: pollingInterval("normal"),
    staleTime: 5000,
    placeholderData: (previousData) => previousData,
  });
  const { data: wallet, isLoading: walletLoading } = trpc.billing.me.useQuery(undefined, { enabled: !isAdmin, placeholderData: (previousData) => previousData });
  const { data: trafficBilling, isLoading: trafficBillingLoading } = trpc.trafficBilling.status.useQuery(undefined, { placeholderData: (previousData) => previousData });
  const { data: subscriptions = [], isLoading: subscriptionsLoading } = trpc.plans.mySubscriptions.useQuery(undefined, { enabled: !isAdmin, placeholderData: (previousData) => previousData });
  const { data: userTraffic = [], isLoading: userTrafficLoading } = trpc.dashboard.userTraffic.useQuery(undefined, { refetchInterval: pollingInterval("slow"), placeholderData: (previousData) => previousData });
  const { data: trafficBreakdown, isLoading: breakdownLoading } = trpc.dashboard.trafficBreakdown.useQuery(
    { hours: 24, limit: 30 },
    { refetchInterval: pollingInterval("slow"), staleTime: 25000, placeholderData: (previousData) => previousData },
  );
  const { data: trafficSeries, isLoading: trendLoading } = trpc.dashboard.trafficSeries.useQuery(
    { hours: 24, bucketMinutes: 60 },
    { refetchInterval: pollingInterval("slow"), staleTime: 25000, placeholderData: (previousData) => previousData },
  );

  const { data: health, isLoading: healthLoading, refetch: refetchHealth } = trpc.dashboard.health.useQuery(undefined, {
    refetchInterval: pollingInterval("normal"),
    placeholderData: (previousData) => previousData,
  });

  /*
    近 24H 流量直接汇总上面那条 series —— 它本来就要取来画图，再为顶上那一个
    数字发一次请求是白跑。series 还没回来时给 undefined 而不是 0：
    「还没有数」和「真的是 0」在这一格上是两回事。
  */
  const recentBytes = useMemo(() => {
    if (!trafficSeries) return undefined;
    return (trafficSeries as any[]).reduce(
      (total, point) => total + (Number(point.bytesIn) || 0) + (Number(point.bytesOut) || 0),
      0,
    );
  }, [trafficSeries]);

  const chartData = useMemo<TrafficChartPoint[]>(
    () =>
      (trafficSeries || []).map((point: any) => ({
        label: formatTrafficTime(point.bucket),
        fullLabel: formatTrafficTime(point.bucket),
        bytesIn: Number(point.bytesIn) || 0,
        bytesOut: Number(point.bytesOut) || 0,
      })),
    [trafficSeries],
  );

  const currentUserTraffic = useMemo(() => {
    if (!userTraffic.length) return null;
    return userTraffic.find((item: any) => Number(item.id) === Number(user?.id)) || userTraffic[0];
  }, [userTraffic, user?.id]);

  const [cachedTrafficBreakdown, setCachedTrafficBreakdown] = useState<typeof trafficBreakdown | null>(null);
  useEffect(() => {
    if (trafficBreakdown) setCachedTrafficBreakdown(trafficBreakdown);
  }, [trafficBreakdown]);
  const visibleTrafficBreakdown = trafficBreakdown || cachedTrafficBreakdown;

  const accountTrafficLimit = Number(currentUserTraffic?.trafficLimit) || 0;
  const trafficUsed = Number(currentUserTraffic?.trafficUsed) || 0;
  const trafficBillingEnabled = !!trafficBilling?.enabled;
  const trafficBillingBytes = Number(trafficBilling?.totalBytes || 0);
  const trafficBillingAmount = Number(trafficBilling?.totalAmountCents || 0);
  const trafficBillingBilledGb = Number(trafficBilling?.totalBilledGb || 0);

  const activeSubscriptions = useMemo(() => {
    const now = Date.now();
    return (subscriptions || []).filter((subscription: any) => {
      const expiresAt = subscription.expiresAt ? new Date(subscription.expiresAt).getTime() : Number.POSITIVE_INFINITY;
      return subscription.status === "active" && expiresAt > now;
    });
  }, [subscriptions]);
  const activeSubscription = activeSubscriptions[0];
  const quota = useMemo(
    () => trafficQuotaBreakdown(currentUserTraffic || user, subscriptions),
    [currentUserTraffic, subscriptions, user],
  );
  const trafficLimit = quota.unlimited
    ? 0
    : accountTrafficLimit > 0
      ? accountTrafficLimit
      : quota.totalBytes;
  const trafficPercent = trafficLimit > 0 ? Math.min(100, Math.round((trafficUsed / trafficLimit) * 100)) : 0;
  const accountStatusLoading = userTrafficLoading || subscriptionsLoading || trafficBillingLoading || (!isAdmin && walletLoading);
  const accountCacheScope = user?.id ? String(user.id) : "current";
  const accountExpiresAt = currentUserTraffic ? currentUserTraffic.expiresAt ?? null : activeSubscription?.expiresAt ?? null;
  const expiry = quota.hasQuota ? getExpiryStatus(accountExpiresAt) : { label: "---", tone: "normal" as const };
  const canForward = isAdmin || !!currentUserTraffic?.canAddRules;
  const canForwardText = canForward ? "转发已启用" : "转发已停用";
  const quotaExpiryText = quota.hasQuota ? formatDate(accountExpiresAt) : "---";
  const quotaProgressText = quota.hasQuota
    ? trafficLimit > 0
      ? `${formatBytes(trafficUsed)} / ${formatBytes(trafficLimit)} (${trafficPercent}%)`
      : `${formatBytes(trafficUsed)} / 不限`
    : "---";
  const quotaProgressValue = quota.hasQuota && trafficLimit > 0 ? trafficPercent : 0;
  const trafficBillingBytesText = trafficBillingEnabled ? formatBytes(trafficBillingBytes) : "未开启";
  const trafficBillingAmountText = trafficBillingEnabled ? money(trafficBillingAmount) : "-";
  const trafficBillingAdminSubtitle = trafficBillingEnabled ? `已计费 ${trafficBillingBilledGb}GB` : "流量计费功能未开启";
  const trafficBillingUserSubtitle = trafficBillingEnabled ? `已计费 ${trafficBillingBilledGb}GB` : "管理员未开启";

  const mobileReminderSnapshot = useMemo(
    () => ({
      trafficLimit: quota.hasQuota ? trafficLimit : 0,
      trafficUsed: quota.hasQuota ? trafficUsed : 0,
      expiresAt: quota.hasQuota ? accountExpiresAt : null,
    }),
    [accountExpiresAt, quota.hasQuota, trafficLimit, trafficUsed],
  );

  const accountSection = (
    <>
      {isAdmin ? (
        <Card className="relative overflow-hidden border-border bg-card">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
          <CardHeader className="pb-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Shield className="h-4 w-4" />
                我的消耗
              </CardTitle>
              <Badge variant="outline" className="border-[color-mix(in_srgb,var(--fx-healthy)_30%,transparent)] text-[var(--fx-healthy-text)]">
                <AnimatedStatValue
                  value="管理员权限"
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.adminBadge`}
                  fallbackValue="管理员权限"
                />
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Activity className="h-3 w-3" />
                  我的已用流量
                </p>
                <AnimatedStatValue
                  as="p"
                  value={formatBytes(trafficUsed)}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.trafficUsed`}
                  fallbackValue="0 B"
                  className="mt-1 text-xl font-semibold tabular-nums"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">按当前登录账号统计</p>
              </div>
              <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Coins className="h-3 w-3" />
                  计费流量
                </p>
                <AnimatedStatValue
                  as="p"
                  value={trafficBillingBytesText}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.billingTraffic`}
                  fallbackValue="未开启"
                  className="mt-1 text-xl font-semibold tabular-nums"
                />
                <AnimatedStatValue
                  as="p"
                  value={trafficBillingAdminSubtitle}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.billingTrafficSubtitle`}
                  fallbackValue="流量计费功能未开启"
                  className="mt-1 text-[11px] text-muted-foreground"
                />
              </div>
              <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <WalletCards className="h-3 w-3" />
                  计费消费
                </p>
                <AnimatedStatValue
                  as="p"
                  value={trafficBillingAmountText}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.billingAmount`}
                  fallbackValue="-"
                  className="mt-1 text-xl font-semibold tabular-nums"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">仅统计当前账号</p>
              </div>
              <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Shield className="h-3 w-3" />
                  权限状态
                </p>
                <AnimatedStatValue
                  as="p"
                  value="管理员"
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.permission`}
                  fallbackValue="管理员"
                  className="mt-1 text-xl font-semibold"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">不受套餐订阅限制</p>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="relative overflow-hidden border-border bg-card">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
          <CardHeader className="pb-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Shield className="h-4 w-4" />
                我的账户状态
              </CardTitle>
              <div className="flex flex-wrap gap-2">
                <Badge variant={canForward ? "outline" : "destructive"} className={canForward ? "border-[color-mix(in_srgb,var(--fx-healthy)_30%,transparent)] text-[var(--fx-healthy-text)]" : ""}>
                  <AnimatedStatValue
                    value={canForwardText}
                    loading={accountStatusLoading}
                    cacheKey={`home.account.${accountCacheScope}.canForward`}
                    fallbackValue="转发已停用"
                  />
                </Badge>
                <Badge variant={expiry.tone === "danger" ? "destructive" : "outline"} className={expiry.tone === "warning" ? "border-[color-mix(in_srgb,var(--fx-warn)_40%,transparent)] text-[var(--fx-warn-text)]" : ""}>
                  <AnimatedStatValue
                    value={expiry.label}
                    loading={accountStatusLoading}
                    cacheKey={`home.account.${accountCacheScope}.expiry`}
                    fallbackValue="---"
                  />
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
              <div className="rounded-lg border border-border/50 bg-background/35 p-3 xl:col-span-2">
                <p className="text-xs text-muted-foreground">流量额度</p>
                <AnimatedStatValue
                  as="p"
                  value={quotaProgressText}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.planProgress`}
                  fallbackValue="---"
                  className="mt-1 text-xl font-semibold tabular-nums"
                />
                {!accountStatusLoading && quota.sources.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    {quota.sources.map((source) => (
                      <span key={source.kind} className="whitespace-nowrap">
                        {quotaSourceLabel(source.kind)} {source.unlimited ? "不限" : formatBytes(source.bytes)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                <p className="text-xs text-muted-foreground">到期时间</p>
                <AnimatedStatValue
                  as="p"
                  value={quotaExpiryText}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.planExpiry`}
                  fallbackValue="---"
                  className="mt-1 text-xl font-semibold tabular-nums"
                />
              </div>
              <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <WalletCards className="h-3 w-3" />
                  账户余额
                </p>
                <AnimatedStatValue
                  as="p"
                  value={money(wallet?.balanceCents)}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.wallet`}
                  fallbackValue={money(0)}
                  className="mt-1 text-xl font-semibold tabular-nums"
                />
              </div>
              <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <WalletCards className="h-3 w-3" />
                  计费流量
                </p>
                <AnimatedStatValue
                  as="p"
                  value={trafficBillingBytesText}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.userBillingTraffic`}
                  fallbackValue="未开启"
                  className="mt-1 text-xl font-semibold tabular-nums"
                />
                <AnimatedStatValue
                  as="p"
                  value={trafficBillingUserSubtitle}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.userBillingTrafficSubtitle`}
                  fallbackValue="管理员未开启"
                  className="mt-1 text-[11px] text-muted-foreground"
                />
              </div>
              <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <WalletCards className="h-3 w-3" />
                  计费消费
                </p>
                <AnimatedStatValue
                  as="p"
                  value={trafficBillingAmountText}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.userBillingAmount`}
                  fallbackValue="-"
                  className="mt-1 text-xl font-semibold tabular-nums"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">仅统计流量计费资源</p>
              </div>
              <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Package className="h-3 w-3" />
                  当前套餐
                </p>
                <AnimatedStatValue
                  as="p"
                  value={activeSubscriptions.length > 1
                    ? `${activeSubscription?.planName || "---"} 等 ${activeSubscriptions.length} 个套餐`
                    : activeSubscription?.planName || "---"}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.planName`}
                  fallbackValue="---"
                  className="mt-1 truncate text-xl font-semibold"
                />
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>流量额度使用进度</span>
                <AnimatedStatValue
                  value={quotaProgressText}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.planProgress.inline`}
                  fallbackValue="---"
                  className="tabular-nums"
                />
              </div>
              <Progress value={quotaProgressValue} className="h-2" />
              <p className="text-[11px] text-muted-foreground">
                {quota.sources.length > 0
                  ? `额度来源：${quota.sources.map((source) => quotaSourceLabel(source.kind)).join("、")}。`
                  : "暂无生效流量额度。"}
                {quota.hasQuota && currentUserTraffic?.trafficAutoReset ? ` 每月 ${currentUserTraffic.trafficResetDay || 1} 日自动重置。` : ""}
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );

  const trafficSection = (
    <TrafficSurface
      recentBytes={recentBytes}
      chartData={chartData}
      chartLoading={trendLoading}
      breakdown={visibleTrafficBreakdown}
      breakdownLoading={breakdownLoading}
      totals={trafficTotals}
      totalsLoading={trafficTotalsLoading}
    />
  );

  /*
    页面从上往下是一个问题接一个问题：有没有问题 → 要处理什么 → 流量怎么样 →
    我的账户。租户把账户提到流量前面：对他来说「额度还剩多少、哪天到期」就是
    他的「系统状态」，比一张走势图要紧。
  */
  return (
    <div className="space-y-6">
      <WorkspaceHeader title="总览" description="查看运行状态、资源使用和流量趋势。" />
      <SystemStatusHeader
        health={health as SystemHealth | undefined}
        loading={healthLoading}
        isAdmin={isAdmin}
        onRetry={() => { void refetchHealth(); }}
      />
      <AttentionSection
        attention={(health as SystemHealth | undefined)?.attention}
        isAdmin={isAdmin}
        onOpen={setLocation}
      />
      {isAdmin ? trafficSection : accountSection}
      {isAdmin ? accountSection : trafficSection}
      <MobileAppSettings snapshot={mobileReminderSnapshot} />
    </div>
  );
}

export default function Home() {
  const { user, loading } = useAuth();
  const { data: settings } = trpc.system.getSettings.useQuery(undefined, {
    enabled: !user && (!mobileAuth.isNative || mobileAuth.hasPanelUrl()),
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!user || typeof window === "undefined") return;
    const welcomeName = window.sessionStorage.getItem(LOGIN_WELCOME_TOAST_KEY);
    if (!welcomeName) return;
    window.sessionStorage.removeItem(LOGIN_WELCOME_TOAST_KEY);
    toast.success(`欢迎回来！${welcomeName} 用户`, { position: "top-right" });
  }, [user?.id]);

  if (loading) return null;

  if (!user) {
    if (mobileAuth.isNative) {
      if (typeof window !== "undefined") window.location.href = "/login";
      return null;
    }
    if (settings?.homepageEnabled !== false) {
      if (settings?.homepageCustomEnabled && settings?.homepageHtml?.trim()) {
        return <CustomPublicHome html={settings.homepageHtml} />;
      }
      return <PublicHome />;
    }
    if (typeof window !== "undefined") window.location.href = "/login";
    return null;
  }

  return (
    <DashboardLayout>
      <DashboardContent />
    </DashboardLayout>
  );
}
