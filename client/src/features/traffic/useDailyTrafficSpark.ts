import { useMemo } from "react";

import { hourlySlots } from "@/lib/hourlySlots";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";

/**
 * 页头右上角那条「近 24H」小走势的数据：这个账号能看到的全部规则近 24 小时逐时的进出字节。
 *
 * 用的是首页图表那条 dashboard.trafficSeries（服务端按用户缓存 30 秒），规则页、主机页各自
 * 调一次也不会多打一次库。返回 24 格（hourlySlots）和进出两个总数。
 */
export function useDailyTrafficSpark(enabled = true) {
  const query = trpc.dashboard.trafficSeries.useQuery(
    { hours: 24, bucketMinutes: 60 },
    {
      enabled,
      refetchInterval: pollingInterval("slow"),
      staleTime: 25_000,
      refetchOnWindowFocus: false,
      placeholderData: (previousData) => previousData,
    },
  );
  const rows = query.data as Array<{ bucket: string | Date; bytesIn: number; bytesOut: number }> | undefined;
  return useMemo(() => {
    const values = hourlySlots(rows, (row) => ({ at: row.bucket, value: (Number(row.bytesIn) || 0) + (Number(row.bytesOut) || 0) }));
    let bytesIn = 0;
    let bytesOut = 0;
    for (const row of rows || []) {
      bytesIn += Number(row.bytesIn) || 0;
      bytesOut += Number(row.bytesOut) || 0;
    }
    return { values, bytesIn, bytesOut, loading: query.isLoading && !rows };
  }, [rows, query.isLoading]);
}
