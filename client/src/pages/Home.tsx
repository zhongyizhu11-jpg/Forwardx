import WorkspaceHeader from "@/components/WorkspaceHeader";
import { useAuth } from "@/_core/hooks/useAuth";
import { quotaSourceLabel } from "@shared/ledgerLabels";
import { formatMoneyCents as money } from "@shared/formatMoney";
import { formatBytes } from "@shared/formatBytes";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import DashboardLayout from "@/components/DashboardLayout";
import MobileAppSettings from "@/components/MobileAppSettings";
import SystemStatusHeader from "@/components/SystemStatusHeader";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { CHART_SEMANTIC_COLORS, chartSeriesColor } from "@/lib/chartPalette";
import { mobileAuth } from "@/lib/mobileAuth";
import { pollingInterval } from "@/lib/polling";
import { trafficQuotaBreakdown, type TrafficQuotaSourceKind } from "@/lib/trafficQuota";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  BarChart3,
  Coins,
  Info,
  Package,
  Shield,
  WalletCards,
  Wifi,
  Zap,
} from "lucide-react";
import { motion } from "motion/react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import PublicHome, { CustomPublicHome } from "./PublicHome";
/*
  两张图按需加载 —— recharts 不再进首屏包。

  仪表盘是所有人的落地页，路由分包那一轮刻意留成同步的；但它 import 的
  recharts 也跟着进了主包。这两张图本来就有不依赖 recharts 的加载态和空态，
  数据没回来那段时间正好够把图表库取回来，所以按需加载在观感上是免费的。
*/
const TrafficPieChart = lazy(() => import("@/components/charts/DashboardTrafficCharts").then((m) => ({ default: m.TrafficPieChart })));
const TrafficAreaChart = lazy(() => import("@/components/charts/DashboardTrafficCharts").then((m) => ({ default: m.TrafficAreaChart })));

const LOGIN_WELCOME_TOAST_KEY = "forwardx.loginWelcome";
/*
  图表色全部收口到 lib/chartPalette。写死十六进制的问题不只是换主题麻烦 ——
  列表里「在线」是语义绿，饼图里的「在线」是另一个绿，同一份数据两种颜色。
*/
const DASHBOARD_RULE_ACTIVE_COLOR = CHART_SEMANTIC_COLORS.path;
const TRAFFIC_PIE_MAX_SEGMENTS = 5;

type TrafficPieDatum = {
  id: number | string;
  name: string;
  value: number;
  color: string;
  percent: number;
};

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

function CircularProgress({ value, color }: { value: number; color: string }) {
  const size = 78;
  const strokeWidth = 6;
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (Math.min(value, 100) / 100) * circumference;

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" strokeWidth={strokeWidth} className="text-muted/30" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-700 ease-out"
        />
      </svg>
      <span className="absolute text-sm font-bold tabular-nums">{Math.round(value)}%</span>
    </div>
  );
}

function FixedColorProgress({ value, color, className = "" }: { value: number; color: string; className?: string }) {
  const normalized = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className={`relative h-4 w-full overflow-hidden rounded-full bg-secondary ${className}`}>
      <div className="h-full rounded-full transition-all" style={{ width: `${normalized}%`, backgroundColor: color }} />
    </div>
  );
}

function TrafficPieLoadingState() {
  return (
    <div className="grid gap-3 sm:grid-cols-[170px_minmax(0,1fr)] lg:grid-cols-1 2xl:grid-cols-[170px_minmax(0,1fr)]">
      <div className="flex h-44 min-w-0 items-center justify-center">
        <div className="relative flex h-32 w-32 items-center justify-center">
          <div className="absolute inset-0 rounded-full border-[18px] border-muted/70" />
          <div className="absolute inset-0 animate-spin rounded-full border-[18px] border-transparent border-r-[color-mix(in_srgb,var(--fx-path)_30%,transparent)] border-t-[color-mix(in_srgb,var(--fx-path)_80%,transparent)]" />
          <div className="absolute inset-7 rounded-full bg-card/90 shadow-inner" />
          <div className="relative space-y-2 text-center">
            <Skeleton className="mx-auto h-4 w-16" />
            <Skeleton className="mx-auto h-2.5 w-8" />
          </div>
        </div>
      </div>
      <div className="space-y-2 py-1 text-xs">
        {[0, 1, 2].map((item) => (
          <div key={item} className="grid grid-cols-[minmax(0,1fr)_4.75rem_3rem] items-center gap-2 border-t border-border/50 py-1.5 first:border-t-0">
            <div className="flex min-w-0 items-center gap-2">
              <Skeleton className="h-2.5 w-2.5 shrink-0 rounded-full" />
              <Skeleton className="h-3 w-5 shrink-0" />
              <Skeleton className="h-3 min-w-0 flex-1" />
            </div>
            <Skeleton className="ml-auto h-3 w-16" />
            <Skeleton className="ml-auto h-3 w-9" />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-2 sm:col-span-2 lg:col-span-1 2xl:col-span-2">
        {[0, 1, 2].map((item) => (
          <div key={item} className="flex items-center gap-1.5">
            <Skeleton className="h-2.5 w-3.5 rounded-sm" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

function TrafficPieCard({
  title,
  data,
  loading,
}: {
  title: string;
  data: Array<{ id: number; name: string; value: number }>;
  loading: boolean;
}) {
  const [hasAnimated, setHasAnimated] = useState(false);
  const chartData = useMemo<TrafficPieDatum[]>(() => {
    const normalized = data
      .map((item) => ({ ...item, value: Number(item.value) || 0 }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value);
    const visible = normalized.slice(0, TRAFFIC_PIE_MAX_SEGMENTS);
    const rest = normalized.slice(TRAFFIC_PIE_MAX_SEGMENTS);
    const merged = rest.length > 0
      ? [...visible, { id: "other", name: "其他", value: rest.reduce((sum, item) => sum + item.value, 0) }]
      : visible;
    const sum = merged.reduce((acc, item) => acc + item.value, 0);
    return merged.map((item, index) => ({
      id: item.id,
      name: item.name,
      value: item.value,
      color: chartSeriesColor(index),
      percent: sum > 0 ? Number(((item.value / sum) * 100).toFixed(1)) : 0,
    }));
  }, [data]);
  const total = chartData.reduce((sum, item) => sum + item.value, 0);
  const shouldAnimate = chartData.length > 0 && total > 0 && !hasAnimated;

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <BarChart3 className="h-4 w-4" />
            {title}
          </CardTitle>
          <span className="text-[10px] text-muted-foreground">近 24H</span>
        </div>
      </CardHeader>
      <CardContent>
        {loading && chartData.length === 0 ? (
          <TrafficPieLoadingState />
        ) : chartData.length === 0 || total <= 0 ? (
          <div className="flex h-56 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <BarChart3 className="h-5 w-5 text-muted-foreground" />
            暂无流量数据
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-[170px_minmax(0,1fr)] lg:grid-cols-1 2xl:grid-cols-[170px_minmax(0,1fr)]">
            <div className="h-44 min-w-0">
              {/* 图表库还在路上时沿用同一个转圈，换过来看不出接缝。 */}
              <Suspense fallback={<div className="flex h-full items-center justify-center"><div className="h-24 w-24 animate-spin rounded-full border-[14px] border-muted/70 border-r-[color-mix(in_srgb,var(--fx-path)_30%,transparent)] border-t-[color-mix(in_srgb,var(--fx-path)_80%,transparent)]" /></div>}>
                <TrafficPieChart
                  chartData={chartData}
                  total={total}
                  shouldAnimate={shouldAnimate}
                  onAnimationEnd={() => setHasAnimated(true)}
                />
              </Suspense>
            </div>
            <div className="max-h-44 min-w-0 overflow-y-auto text-xs">
              {chartData.map((item, index) => (
                <div
                  key={item.id}
                  className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(4.75rem,max-content)_3rem] items-center gap-2 border-t border-border/50 py-1.5 first:border-t-0"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                    <span className="w-5 shrink-0 text-[11px] font-semibold text-muted-foreground">#{index + 1}</span>
                    <span className="min-w-0 truncate font-medium" title={item.name}>{item.name}</span>
                  </div>
                  <div className="whitespace-nowrap text-right text-muted-foreground tabular-nums">
                    {formatBytes(item.value)}
                  </div>
                  <div className="whitespace-nowrap text-right font-semibold tabular-nums">
                    {item.percent}%
                  </div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-2 sm:col-span-2 lg:col-span-1 2xl:col-span-2">
              {chartData.map((item) => (
                <div key={item.id} className="flex max-w-full items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="h-2.5 w-3.5 shrink-0 rounded-sm" style={{ backgroundColor: item.color }} />
                  <span className="max-w-28 truncate">{item.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DashboardContent() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { data: stats, isLoading } = trpc.dashboard.stats.useQuery(undefined, { refetchInterval: pollingInterval("normal"), placeholderData: (previousData) => previousData });
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

  const chartData = useMemo(
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

  const onlineRate = stats?.totalHosts ? Math.round((stats.onlineHosts / stats.totalHosts) * 100) : 0;
  const activeRate = stats?.totalRules ? Math.round((stats.activeRules / stats.totalRules) * 100) : 0;
  const tunnelRuleTrafficData = useMemo(
    () => (visibleTrafficBreakdown?.tunnelRules || []).map((item: any) => ({ id: Number(item.id), name: item.name, value: Number(item.totalBytes) || 0 })),
    [visibleTrafficBreakdown?.tunnelRules],
  );
  const portRuleTrafficData = useMemo(
    () => (visibleTrafficBreakdown?.portRules || []).map((item: any) => ({ id: Number(item.id), name: item.name, value: Number(item.totalBytes) || 0 })),
    [visibleTrafficBreakdown?.portRules],
  );
  const forwardGroupRuleTrafficData = useMemo(
    () => (visibleTrafficBreakdown?.forwardGroupRules || []).map((item: any) => ({ id: Number(item.id), name: item.name, value: Number(item.totalBytes) || 0 })),
    [visibleTrafficBreakdown?.forwardGroupRules],
  );

  return (
    <div className="space-y-6">
      <WorkspaceHeader title="总览" description="查看运行状态、资源使用和流量趋势。" />
      <SystemStatusHeader
        health={health as any}
        recentBytes={recentBytes}
        loading={healthLoading}
        isAdmin={isAdmin}
        onRetry={() => { void refetchHealth(); }}
      />

      {/*
        主机和转发这两个数已经在顶上那一行里了，不再用一张渐变卡片重复一遍。
        这里只留「累计流量」—— 它和顶上那个「近 24H」是两个口径，放一起才说得清。
      */}
      <section className="grid grid-cols-2 gap-4 rounded-lg border bg-card p-4 sm:p-5">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">累计入站</div>
          <div className="mt-1 truncate text-xl font-semibold tabular-nums tracking-tight">
            {trafficTotalsLoading && !trafficTotals ? "—" : formatBytes(trafficTotals?.totalTrafficIn ?? 0)}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">累计出站</div>
          <div className="mt-1 truncate text-xl font-semibold tabular-nums tracking-tight">
            {trafficTotalsLoading && !trafficTotals ? "—" : formatBytes(trafficTotals?.totalTrafficOut ?? 0)}
          </div>
        </div>
      </section>

      <MobileAppSettings snapshot={mobileReminderSnapshot} />

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

      <Card className="border-border bg-card">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <BarChart3 className="h-4 w-4" />
              近 24H 流量展示
              <span className="text-[10px] font-normal text-muted-foreground">每小时汇总</span>
            </CardTitle>
            <div className="flex items-center gap-3 text-[10px]">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[var(--fx-healthy)]" />
                入站
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[var(--fx-warn)]" />
                出站
              </span>
            </div>
          </div>
          <p className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
            <Info className="h-3 w-3" />
            每小时汇总一次可见规则流量。
          </p>
        </CardHeader>
        <CardContent>
          <div className="h-52 w-full sm:h-64">
            {trendLoading && !trafficSeries ? (
              <Skeleton className="h-full w-full" />
            ) : chartData.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">暂无流量数据</div>
            ) : (
              <Suspense fallback={<Skeleton className="h-full w-full" />}>
                <TrafficAreaChart chartData={chartData} />
              </Suspense>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <TrafficPieCard title="隧道流量" data={tunnelRuleTrafficData} loading={breakdownLoading} />
        <TrafficPieCard title="端口转发流量" data={portRuleTrafficData} loading={breakdownLoading} />
        <TrafficPieCard title="转发组流量" data={forwardGroupRuleTrafficData} loading={breakdownLoading} />
      </div>

      <div className={`grid grid-cols-1 gap-4 ${isAdmin ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}>
        {isAdmin && (
          <Card className="border-border bg-card">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Wifi className="h-4 w-4" />
                主机在线率
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-6">
                {isLoading ? <Skeleton className="h-20 w-20 rounded-full" /> : <CircularProgress value={onlineRate} color={CHART_SEMANTIC_COLORS.healthy} />}
                <div className="space-y-1 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-[var(--fx-healthy)]" />
                    在线 {stats?.onlineHosts ?? 0}
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
                    离线 {(stats?.totalHosts ?? 0) - (stats?.onlineHosts ?? 0)}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="border-border bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Zap className="h-4 w-4" />
              规则启用率
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-6">
              {isLoading ? <Skeleton className="h-20 w-20 rounded-full" /> : <CircularProgress value={activeRate} color={DASHBOARD_RULE_ACTIVE_COLOR} />}
              <div className="space-y-1 text-sm">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: DASHBOARD_RULE_ACTIVE_COLOR }} />
                  已启用 {stats?.activeRules ?? 0}
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
                  停用 {(stats?.totalRules ?? 0) - (stats?.activeRules ?? 0)}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Activity className="h-4 w-4" />
              系统概览
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">规则负载</span>
              <div className="flex w-32 items-center gap-2">
                <FixedColorProgress value={activeRate} color={DASHBOARD_RULE_ACTIVE_COLOR} className="h-1.5" />
                <span className="w-8 text-right text-xs font-medium tabular-nums">{activeRate}%</span>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">用户角色</span>
              <Badge variant="secondary" className="px-2 py-0.5 text-[10px]">
                {isAdmin ? (
                  <>
                    <Shield className="mr-1 h-3 w-3" />
                    管理员
                  </>
                ) : (
                  "普通用户"
                )}
              </Badge>
            </div>
          </CardContent>
        </Card>
      </div>
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
