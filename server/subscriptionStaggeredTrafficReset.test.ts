import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 错开日子买的多份订阅，不能每份的开通日都把共用的已用流量清零一次。
 *
 * users.trafficUsed 只有一个，额度是所有订阅相加。以前按开通日锚定时，每份订阅的
 * 锚点到了都会清一次 —— 月初买一份、月中再买一份便宜的，一个月清两次，额度翻倍。
 * 现在只跟主订阅（生效、有限额、开通最早）的周期清。
 */
test("错开开通的多份订阅只按主订阅的周期清共用流量计数器", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-staggered-reset-"));
  const databasePath = path.join(directory, "staggered.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const billing = await import(url("server/repositories/billingRepository.ts"));
    const DAY = 86400;
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, p = []) => runtime.executeRaw(sql, p);
      const query = (sql, p = []) => runtime.queryRaw(sql, p);
      const nowSec = Math.floor(Date.now() / 1000);

      await exec("INSERT INTO users (id, username, password, role, trafficUsed, trafficAutoReset, canAddRules, accountEnabled) VALUES (1, 'u', 'h', 'user', 1500, 0, 1, 1)");
      await exec("INSERT INTO hosts (id, name, ip, userId, portRangeStart, portRangeEnd) VALUES (1, 'h', '127.0.0.1', 1, 10000, 10100)");
      for (const planId of [1, 2]) {
        await exec("INSERT INTO subscription_plans (id, name, durationDays, portCount, trafficLimit) VALUES (?, ?, 365, 1, 1000)", [planId, "Plan " + planId]);
        await exec("INSERT INTO subscription_plan_hosts (planId, hostId) VALUES (?, 1)", [planId]);
      }
      // 主订阅：40 天前开通，下次重置还在后头。
      await exec(
        "INSERT INTO user_subscriptions (id, userId, planId, status, portRangeStart, portRangeEnd, startedAt, expiresAt, nextTrafficResetAt) VALUES (11, 1, 1, 'active', 10000, 10000, ?, ?, ?)",
        [nowSec - 40 * DAY, nowSec + 300 * DAY, nowSec + 20 * DAY],
      );
      // 附加订阅：错开 20 天开通，它的锚点已经到了。
      await exec(
        "INSERT INTO user_subscriptions (id, userId, planId, status, portRangeStart, portRangeEnd, startedAt, expiresAt, nextTrafficResetAt) VALUES (12, 1, 2, 'active', 10001, 10001, ?, ?, ?)",
        [nowSec - 20 * DAY - 3600, nowSec + 300 * DAY, nowSec - 3600],
      );
      const used = async () => Number((await query('SELECT "trafficUsed" FROM "users" WHERE "id" = 1'))[0].trafficUsed);
      const nextReset = async (id) => Number((await query('SELECT "nextTrafficResetAt" FROM "user_subscriptions" WHERE "id" = ?', [id]))[0].nextTrafficResetAt || 0);

      const resets = await billing.rechargeSubscriptionTrafficCycles();
      assert.equal(resets, 0, "附加订阅的锚点不清共用计数器");
      assert.equal(await used(), 1500, "已用流量要留着，否则额度成倍放大");
      assert.ok(await nextReset(12) > nowSec, "附加订阅自己的周期照常往后推");

      // 主订阅的锚点到了：清零。
      await exec('UPDATE "user_subscriptions" SET "nextTrafficResetAt" = ? WHERE "id" = 11', [nowSec - 60]);
      const primaryResets = await billing.rechargeSubscriptionTrafficCycles();
      assert.equal(primaryResets, 1);
      assert.equal(await used(), 0, "主订阅的周期到了才清");
      assert.ok(await nextReset(11) > nowSec);
      console.log("STAGGERED_OK");
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: databasePath,
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
        NODE_ENV: "test",
      },
      timeout: 120000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /STAGGERED_OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
