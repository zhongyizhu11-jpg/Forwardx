import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 面板内切换数据库：
 *
 * - 原来切换期间面板照常接受写入（管理员改配置、Agent 上报、调度器扣费），写进已经
 *   读过的表就丢了，写进还没读的表新旧两边就对不上。切换期间要冻结写入：tRPC 的
 *   mutation 返回 503「数据库迁移中」、定时任务整轮跳过；切完（不用重启时）解冻。
 * - 原来每张表一句 SELECT * 整库读进内存再写，大库直接 OOM；改成按主键分批读写，
 *   这里用跨多个批次的表确认一行不少、运行时缓存照旧不带走。
 */
test("数据库切换期间冻结写入，按主键分批把数据完整搬到新库，切完解冻", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-db-switch-freeze-"));
  const sourcePath = path.join(directory, "source.db");
  const targetPath = path.join(directory, "target.db");
  const configPath = path.join(directory, "database.json");
  fs.writeFileSync(configPath, JSON.stringify({ type: "sqlite", sqlite: { path: sourcePath } }));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      console.info = () => {};
      console.warn = () => {};
      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      await runtime.connectDatabase();
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);

      await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
      const PERMISSIONS = 2345;
      const BULK_SETTINGS = 1200;
      await runtime.withDatabaseTransaction(async () => {
        for (let hostId = 1; hostId <= PERMISSIONS; hostId += 1) {
          await exec('INSERT INTO user_host_permissions ("userId", "hostId") VALUES (1, ?)', [hostId]);
        }
        for (let index = 0; index < BULK_SETTINGS; index += 1) {
          await exec('INSERT INTO system_settings (key, value, "updatedAt") VALUES (?, ?, ?)', ["bulk:" + String(index).padStart(5, "0"), "v" + index, 1]);
        }
        await exec('INSERT INTO system_settings (key, value, "updatedAt") VALUES (?, ?, ?)', ["runtimeCache:exitPorts", "{}", 1]);
      });

      const sw = await import(url("server/databaseSwitch.ts"));
      const maintenance = await import(url("server/databaseMaintenance.ts"));
      const { createNonOverlappingScheduledTask } = await import(url("server/scheduledTask.ts"));
      const { router, publicProcedure } = await import(url("server/_core/trpc.ts"));
      assert.ok(sw.DATABASE_SWITCH_COPY_BATCH_ROWS < PERMISSIONS, "测试数据要跨好几个批次");

      const probeRouter = router({
        write: publicProcedure.mutation(() => "written"),
        read: publicProcedure.query(() => "read"),
      });
      const caller = probeRouter.createCaller({});
      let scheduledRuns = 0;
      const scheduled = createNonOverlappingScheduledTask("probe", async () => { scheduledRuns += 1; });

      const job = sw.startDatabaseSwitch({ type: "sqlite", sqlite: { path: process.env.TARGET_DB } });
      let checkedWhileFrozen = false;
      for (;;) {
        const current = sw.getDatabaseSwitchJob(job.id);
        if (!checkedWhileFrozen && maintenance.isDatabaseMaintenanceActive()) {
          checkedWhileFrozen = true;
          await assert.rejects(caller.write(), (error) => {
            assert.equal(error.code, "SERVICE_UNAVAILABLE");
            assert.match(error.message, /数据库迁移中/);
            return true;
          });
          assert.equal(await caller.read(), "read", "查询照常：管理员要能看切换进度");
          assert.equal(await scheduled(), false, "定时任务整轮跳过");
          assert.equal(scheduledRuns, 0);
        }
        if (current.status === "success" || current.status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const finished = sw.getDatabaseSwitchJob(job.id);
      assert.equal(finished.status, "success", JSON.stringify(finished));
      assert.ok(checkedWhileFrozen, "切换期间必须冻结写入");
      assert.equal(maintenance.isDatabaseMaintenanceActive(), false, "同类型切换不用重启，切完要解冻");
      assert.equal(await caller.write(), "written");
      assert.equal(finished.summary.tableCounts.user_host_permissions, PERMISSIONS);

      const Database = (await import("better-sqlite3")).default;
      const target = new Database(process.env.TARGET_DB, { readonly: true });
      assert.equal(target.prepare("SELECT COUNT(*) AS n FROM user_host_permissions").get().n, PERMISSIONS, "跨批次的表一行都不能少");
      assert.equal(target.prepare("SELECT COUNT(DISTINCT \"hostId\") AS n FROM user_host_permissions").get().n, PERMISSIONS, "也不能重复");
      assert.equal(target.prepare("SELECT COUNT(*) AS n FROM system_settings WHERE key LIKE 'bulk:%'").get().n, BULK_SETTINGS);
      assert.equal(target.prepare("SELECT COUNT(*) AS n FROM system_settings WHERE key LIKE 'runtimeCache:%'").get().n, 0);
      target.close();
      console.log("OK");
      process.exit(0);
    `;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_CONFIG_PATH: configPath,
      SQLITE_PATH: sourcePath,
      TARGET_DB: targetPath,
      FORWARDX_LOG_DIR: path.join(directory, "logs"),
    };
    for (const key of ["DATABASE_TYPE", "DB_TYPE", "DB_CONFIG_PATH", "MYSQL_URL", "MYSQL_HOST", "POSTGRES_URL", "POSTGRES_HOST"]) delete env[key];
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
      timeout: 180_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
