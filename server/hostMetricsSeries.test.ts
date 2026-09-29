import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// dbRuntime 在加载时就读数据库类型，得在第一次 import 之前定下来
process.env.DATABASE_TYPE = "sqlite";

test("主机指标走势：按等长时间格压缩，速率由累计计数差分，回绕算 0", async () => {
  const { downsampleHostMetricSeries } = await import("./repositories/metricsRepository");
  const since = new Date("2026-09-29T00:00:00Z");
  const until = new Date("2026-09-29T01:00:00Z");
  // 每分钟一条，60 条 → 压成 6 格（每格 10 分钟）
  const rows = Array.from({ length: 60 }, (_, i) => ({
    cpuUsage: i < 30 ? 10 : 50,
    memoryUsage: 40,
    memoryUsed: 4 * 1024 ** 3,
    // 每分钟进 6 MB → 100 KB/s；第 45 分钟计数回绕
    networkIn: i < 45 ? i * 6 * 1024 ** 2 : (i - 45) * 6 * 1024 ** 2,
    networkOut: i * 3 * 1024 ** 2,
    diskUsage: 36,
    diskUsed: 72 * 1024 ** 3,
    diskTotal: 200 * 1024 ** 3,
    uptime: 1000 + i * 60,
    recordedAt: Math.floor(since.getTime() / 1000) + i * 60,
  }));
  const points = downsampleHostMetricSeries(rows, { since, until, maxPoints: 6 });
  assert.equal(points.length, 6);
  assert.equal(points[0].cpuUsage, 10);
  assert.equal(points[5].cpuUsage, 50);
  assert.equal(points[2].cpuUsage, 10, "第三格（20~29 分）还全是 10");
  assert.equal(points[3].cpuUsage, 50);
  const inRate = Math.round((6 * 1024 ** 2) / 60);
  assert.equal(points[0].networkSpeedIn, inRate, "第一格里 10 条样本有 9 次差分");
  assert.equal(points[1].networkSpeedIn, inRate);
  assert.equal(points[1].networkSpeedOut, Math.round((3 * 1024 ** 2) / 60));
  // 第 5 格（40~49 分）里有一次回绕：那一分钟按 0 算，格平均低于正常速率但不为负
  assert.ok((points[4].networkSpeedIn || 0) > 0 && (points[4].networkSpeedIn || 0) < inRate, String(points[4].networkSpeedIn));
  assert.equal(points[5].uptime, 1000 + 59 * 60, "格里取最后一条的 uptime");
  assert.equal(points[5].diskTotal, 200 * 1024 ** 3);
  assert.ok(points.every((p, i) => i === 0 || p.at.getTime() > points[i - 1].at.getTime()), "按时间升序");
});

test("主机指标走势：空格跳过、不补零；早于 since 的行不算", async () => {
  const { downsampleHostMetricSeries } = await import("./repositories/metricsRepository");
  const since = new Date("2026-09-29T00:00:00Z");
  const until = new Date("2026-09-29T00:10:00Z");
  const base = Math.floor(since.getTime() / 1000);
  const row = (offset: number, cpu: number) => ({
    cpuUsage: cpu, memoryUsage: null, memoryUsed: null, networkIn: null, networkOut: null,
    diskUsage: null, diskUsed: null, diskTotal: null, uptime: null, recordedAt: base + offset,
  });
  const points = downsampleHostMetricSeries([row(-60, 99), row(0, 1), row(9 * 60, 9)], { since, until, maxPoints: 10 });
  assert.equal(points.length, 2, "中间八格没有样本就不出现");
  assert.deepEqual(points.map((p) => p.cpuUsage), [1, 9]);
  assert.equal(points[0].memoryUsage, null);
  assert.equal(points[1].networkSpeedIn, null, "计数为空时不算速率");
});

test("SQLite：getHostMetricsSeries 只取这台主机、时间窗内的行，点数不超过上限", async () => {
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const metrics = await import("./repositories/metricsRepository");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-metrics-series-"));
  const databasePath = path.join(directory, "series.db");
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: databasePath } });
    await ensureDatabaseSchema();
    const now = Math.floor(Date.now() / 1000);
    await runtime.withSqliteExclusive((sqlite) => {
      const insert = sqlite.prepare(
        `INSERT INTO host_metrics (hostId, cpuUsage, memoryUsage, networkIn, networkOut, recordedAt) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      sqlite.transaction(() => {
        // 主机 1：过去 24 小时每分钟一条（1440 行）；再加一条 30 小时前的旧数据
        for (let i = 0; i < 1440; i += 1) insert.run(1, 20, 50, i * 1000, i * 500, now - (1440 - i) * 60);
        insert.run(1, 95, 95, 0, 0, now - 30 * 3600);
        // 主机 2：不该混进来
        insert.run(2, 70, 70, 0, 0, now - 60);
      })();
    });
    const points = await metrics.getHostMetricsSeries(1, { since: new Date((now - 24 * 3600) * 1000), maxPoints: 288 });
    assert.ok(points.length > 0 && points.length <= 288, `点数 ${points.length}`);
    assert.ok(points.every((p) => p.cpuUsage === 20), "只有主机 1 近 24 小时的样本");
    assert.ok(points.every((p) => p.at.getTime() >= (now - 24 * 3600) * 1000));
    const withSpeed = points.filter((p) => p.networkSpeedIn !== null);
    assert.ok(withSpeed.length > 0);
    assert.ok(withSpeed.every((p) => Math.abs((p.networkSpeedIn || 0) - 1000 / 60) < 1), "每分钟 1000 字节 ≈ 16.7 B/s");
  } finally {
    await runtime.closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
