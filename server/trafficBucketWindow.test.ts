import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  24 小时流量汇总 / 首页走势改成「整桶读桶表、两头读原始样本」之后，结果必须和老算法一样：
    - 汇总：整段扫 traffic_stats，原始样本里没有的 (规则, 主机) 再拿 floor(since) 起的桶补；
    - 走势：整段扫 traffic_stats 按桶宽分组。
  这里固定时钟（当前桶只过去了 1000 秒），走真实的写入路径 insertTrafficStatsBatch 灌数据，
  再拿老算法的 SQL 当参照逐项比对。全零样本不进桶，只影响「有没有一行 0」，比对时去掉全零行。
*/
test("traffic summaries and series read full buckets but match the raw-sample computation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-traffic-window-"));
  const databasePath = path.join(directory, "traffic.db");
  const fixedNow = Math.floor(Date.now() / 1000 / 1800) * 1800 + 1000;
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const FIXED = Number(process.env.FIXED_NOW);
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { if (args.length === 0) super(FIXED * 1000); else super(...args); }
      static now() { return FIXED * 1000; }
    };
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const metrics = await import(url("server/repositories/metricsRepository.ts"));
    const settings = await import(url("server/repositories/settingsRepository.ts"));
    const dashboard = await import(url("server/repositories/dashboardRepository.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await settings.setSetting("trafficStatBucketsBackfilled", "v3");

      // 规则：101/102 一直有流量；103 只在 24h 窗口开头那一桶的 since 之前有流量；
      // 104 窗口里只有全零样本；105 有流量但之后被删了；106 换过主机；107 只在当前这一桶有流量；
      // 108 since 之前有流量、窗口里只有全零样本（老算法给 0，不拿桶补）。
      const ruleRows = [
        [101, 5, 7, 20101], [102, 5, 1, 20102], [103, 6, 7, 20103], [104, 6, 7, 20104],
        [105, 5, 7, 20105], [106, 5, 7, 20106], [107, 6, 7, 20107], [108, 6, 7, 20108],
      ];
      for (const [id, hostId, userId, port] of ruleRows) {
        await runtime.executeRaw(
          "INSERT INTO forward_rules (id, hostId, name, sourcePort, targetIp, targetPort, userId) VALUES (?, ?, ?, ?, '127.0.0.1', 80, ?)",
          [id, hostId, "rule-" + id, port, userId],
        );
      }
      const since24 = FIXED - 24 * 3600;
      const leadStart = Math.floor(since24 / 1800) * 1800;
      const items = [];
      const sample = (ruleId, hostId, userId, at, bytesIn, bytesOut, connections = 1) => items.push({
        stat: { ruleId, hostId, bytesIn, bytesOut, connections, recordedAt: new Date(at * 1000) },
        userId,
      });
      for (let at = FIXED - 30 * 3600; at <= FIXED; at += 300) {
        sample(101, 5, 7, at, 1000 + (at % 997), 2000 + (at % 991), 1 + (at % 3));
        sample(102, 5, 1, at + 7, 3000 + (at % 113), 4000 + (at % 127));
        sample(105, 5, 7, at + 11, 500, 600);
      }
      for (let at = FIXED - 30 * 3600; at <= FIXED; at += 900) {
        sample(104, 6, 7, at, 0, 0, 0);
        sample(106, at < FIXED - 10 * 3600 ? 9 : 5, 7, at, 700, 800);
      }
      sample(103, 6, 7, leadStart + 100, 4242, 4343);
      sample(108, 6, 7, leadStart + 120, 5252, 5353);
      for (let at = since24 + 3600; at < FIXED - 3600; at += 1800) sample(108, 6, 7, at, 0, 0, 0);
      sample(107, 6, 7, FIXED - 200, 9999, 8888, 2);
      sample(107, 6, 7, FIXED - 5, 1, 2, 0);
      // 一次上报里的样本时间相同（线上 recordedAt 都是面板的当前时间），按时间分批写
      const byTime = new Map();
      for (const item of items) {
        const at = item.stat.recordedAt.getTime();
        byTime.set(at, [...(byTime.get(at) || []), item]);
      }
      for (const batch of byTime.values()) {
        await runtime.withDatabaseTransaction(() => metrics.insertTrafficStatsBatch(batch));
      }
      await runtime.executeRaw("DELETE FROM forward_rules WHERE id = 105");

      const q = (sqlText, params = []) => runtime.queryRaw(sqlText, params);
      const parentJoin = "LEFT JOIN forward_rules parent ON parent.id = fr.forwardGroupRuleId AND parent.forwardGroupId = fr.forwardGroupId AND parent.isForwardGroupTemplate = 1";
      const key = (row) => row.ruleId + ":" + row.hostId;
      const nonZero = (rows) => rows
        .map((row) => ({ ruleId: Number(row.ruleId), hostId: Number(row.hostId), bytesIn: Number(row.bytesIn), bytesOut: Number(row.bytesOut), connections: Number(row.connections) }))
        .filter((row) => row.bytesIn || row.bytesOut || row.connections)
        .sort((a, b) => a.ruleId - b.ruleId || a.hostId - b.hostId);

      // 老算法：整段原始样本 + 原始样本缺的 (规则, 主机) 用 floor(since) 起的桶补，再按规则归属 / 请求过滤
      async function oldSummary({ userId, ruleIds, since }) {
        const sinceSec = Math.floor(since.getTime() / 1000);
        const idWhere = ruleIds ? " AND ts.ruleId IN (" + ruleIds.join(",") + ")" : "";
        const raw = await q(
          "SELECT ts.ruleId AS ruleId, ts.hostId AS hostId, SUM(ts.bytesIn) AS bytesIn, SUM(ts.bytesOut) AS bytesOut, SUM(ts.connections) AS connections"
          + " FROM traffic_stats ts INNER JOIN forward_rules fr ON fr.id = ts.ruleId " + parentJoin
          + " WHERE ts.recordedAt >= ?" + (userId ? " AND COALESCE(parent.userId, fr.userId) = ?" : "") + idWhere
          + " GROUP BY ts.ruleId, ts.hostId",
          userId ? [sinceSec, userId] : [sinceSec],
        );
        const buckets = await q(
          "SELECT b.ruleId AS ruleId, b.hostId AS hostId, SUM(b.bytesIn) AS bytesIn, SUM(b.bytesOut) AS bytesOut, SUM(b.connections) AS connections"
          + " FROM traffic_stat_buckets b" + (userId ? " LEFT JOIN forward_rules fr ON fr.id = b.ruleId " + parentJoin : "")
          + " WHERE b.bucketMinutes = 30 AND b.bucketStart >= ?" + (userId ? " AND COALESCE(parent.userId, fr.userId, b.userId) = ?" : "")
          + idWhere.replaceAll("ts.", "b.") + " GROUP BY b.ruleId, b.hostId",
          userId ? [Math.floor(sinceSec / 1800) * 1800, userId] : [Math.floor(sinceSec / 1800) * 1800],
        );
        const present = new Set(raw.map(key));
        let rows = buckets.length ? [...raw, ...buckets.filter((row) => !present.has(key(row)))] : raw;
        if (userId) {
          const owned = new Set((await q("SELECT id FROM forward_rules WHERE userId = ?", [userId])).map((row) => Number(row.id)));
          rows = rows.filter((row) => owned.has(Number(row.ruleId)));
        }
        if (ruleIds) {
          const visible = await q("SELECT id, hostId FROM forward_rules WHERE id IN (" + ruleIds.join(",") + ") AND pendingDelete = 0" + (userId ? " AND userId = " + userId : ""));
          const visibleIds = new Set(visible.map((row) => Number(row.id)));
          rows = rows.filter((row) => visibleIds.has(Number(row.ruleId)));
        }
        return nonZero(rows);
      }

      const sinceList = [
        since24,
        leadStart,
        FIXED - 600,
        FIXED - 1000,
        FIXED - 3700,
        FIXED - 71 * 3600 + 17,
      ];
      const allIds = [101, 102, 103, 104, 105, 106, 107, 108];
      let compared = 0;
      for (const sinceSec of sinceList) {
        const since = new Date(sinceSec * 1000);
        for (const userId of [undefined, 7, 1]) {
          for (const ruleIds of [undefined, allIds, [101, 103, 108]]) {
            const expected = await oldSummary({ userId, ruleIds, since });
            const actual = nonZero(await metrics.getTrafficSummaryByRule({ userId, ruleIds, since, includeLatency: false }));
            assert.deepEqual(actual, expected, "summary since=" + (sinceSec - FIXED) + " user=" + userId + " ids=" + (ruleIds || "all"));
            compared += 1;
          }
        }
      }
      assert.equal(compared, sinceList.length * 9);

      // 关键几行：103 只在 since 之前有流量 —— 窗口里没有原始样本，老算法拿开头那一桶补；
      // 108 窗口里有全零样本，老算法给 0；删掉的 105 不算进按用户 / 按规则的汇总；107 在当前这一桶。
      const day = new Map(nonZero(await metrics.getTrafficSummaryByRule({ since: new Date(since24 * 1000), includeLatency: false })).map((row) => [key(row), row]));
      assert.equal(day.get("103:6")?.bytesIn, 4242);
      assert.equal(day.has("108:6"), false);
      assert.equal(day.get("107:6")?.bytesIn, 10000);
      assert.ok(day.get("105:5")?.bytesIn > 0, "admin overview still shows a deleted rule's bucketed traffic");

      // 首页走势：任何桶宽都和整段扫原始样本逐点相同（按用户时和原始样本一样 INNER JOIN 规则表）
      for (const sinceSec of sinceList) {
        for (const bucketMinutes of [30, 60, 45, 5]) {
          for (const userId of [undefined, 7, 1]) {
            const bucketSec = bucketMinutes * 60;
            const series = await metrics.getGlobalTrafficSeries({ bucketMinutes, since: new Date(sinceSec * 1000), userId });
            const raw = await q(
              "SELECT CAST(ts.recordedAt / " + bucketSec + " AS INTEGER) * " + bucketSec + " AS bucket, SUM(ts.bytesIn) AS bytesIn, SUM(ts.bytesOut) AS bytesOut FROM traffic_stats ts"
              + (userId ? " INNER JOIN forward_rules fr ON fr.id = ts.ruleId " + parentJoin : "")
              + " WHERE ts.recordedAt >= ?" + (userId ? " AND COALESCE(parent.userId, fr.userId) = ?" : "") + " GROUP BY 1",
              userId ? [sinceSec, userId] : [sinceSec],
            );
            const byBucket = new Map(raw.map((row) => [Number(row.bucket), row]));
            assert.ok(series.length > 0);
            for (const point of series) {
              const expected = byBucket.get(point.bucket.getTime() / 1000);
              assert.deepEqual(
                [point.bytesIn, point.bytesOut],
                [Number(expected?.bytesIn || 0), Number(expected?.bytesOut || 0)],
                "series since=" + (sinceSec - FIXED) + " bucket=" + bucketMinutes + " user=" + userId + " at=" + point.bucket.toISOString(),
              );
            }
            const total = series.reduce((sum, point) => sum + point.bytesIn, 0);
            assert.equal(total, raw.reduce((sum, row) => sum + Number(row.bytesIn), 0));
          }
        }
      }

      // 首页「流量去向」走同一份汇总
      const breakdown = await dashboard.getDashboardTrafficBreakdown({ userId: 7, since: new Date(since24 * 1000), limit: 30 });
      const breakdownTotal = [...breakdown.portRules, ...breakdown.tunnelRules, ...breakdown.forwardGroupRules].reduce((sum, item) => sum + item.bytesIn, 0);
      const expectedUserTotal = (await oldSummary({ userId: 7, since: new Date(since24 * 1000) })).reduce((sum, row) => sum + row.bytesIn, 0);
      assert.equal(breakdownTotal, expectedUserTotal);
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FIXED_NOW: String(fixedNow) },
    encoding: "utf8",
    timeout: 120_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
