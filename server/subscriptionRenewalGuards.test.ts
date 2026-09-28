import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function runInDatabase(marker: string, body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-renewal-guards-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      const billing = await import(url("server/repositories/billingRepository.ts"));
      const settings = await import(url("server/repositories/settingsRepository.ts"));
      const { billingRouter } = await import(url("server/routers/billing.ts"));
      try {
        await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
        await schema.ensureDatabaseSchema();
        const exec = (sql, p = []) => runtime.executeRaw(sql, p);
        const query = (sql, p = []) => runtime.queryRaw(sql, p);
        const nowSec = Math.floor(Date.now() / 1000);
        const DAY = 86400;
        ${body}
        console.log(${JSON.stringify(marker)});
      } finally {
        await runtime.closeDatabase().catch(() => undefined);
      }
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "renewal.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
        NODE_ENV: "test",
      },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(marker));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * 过期后再续费：订阅一过期，它的端口段就不再算占用，可能已经分给了别人。
 * 续费时要复核，被占了就像新购一样重新分一段；分不到是永久失败（在线支付那边转入余额）。
 */
test("续费已过期的订阅时复核旧端口段，被别人占了就重新分配", () => {
  runInDatabase("RENEW_PORT_OK", String.raw`
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'a', 'h', 'user'), (2, 'b', 'h', 'user')");
    await exec("INSERT INTO hosts (id, name, ip, userId, portRangeStart, portRangeEnd) VALUES (1, 'wide', '127.0.0.1', 1, 10000, 10010)");
    await exec("INSERT INTO hosts (id, name, ip, userId, portRangeStart, portRangeEnd) VALUES (2, 'narrow', '127.0.0.2', 1, 20000, 20000)");
    await exec("INSERT INTO subscription_plans (id, name, durationDays, portCount, trafficLimit) VALUES (1, 'wide', 30, 1, 0), (2, 'narrow', 30, 1, 0)");
    await exec("INSERT INTO subscription_plan_hosts (planId, hostId) VALUES (1, 1), (2, 2)");
    const sub = (id, userId, planId, status, port, expiresAt) => exec(
      "INSERT INTO user_subscriptions (id, userId, planId, status, source, portRangeStart, portRangeEnd, startedAt, expiresAt) VALUES (?, ?, ?, ?, 'payment', ?, ?, ?, ?)",
      [id, userId, planId, status, port, port, nowSec - 60 * DAY, expiresAt],
    );
    const range = async (id) => (await query("SELECT portRangeStart AS s, portRangeEnd AS e FROM user_subscriptions WHERE id = ?", [id]))[0];

    // 用户 1 的订阅过期了，10000 随后分给了用户 2。
    await sub(11, 1, 1, "expired", 10000, nowSec - DAY);
    await sub(21, 2, 1, "active", 10000, nowSec + 30 * DAY);
    const renewed = await billing.applySubscriptionToUser(1, 1, "payment", "ORDER-1", undefined, null, 11);
    assert.notEqual(renewed.portRangeStart, 10000, "不能和别人的生效订阅共用端口段");
    assert.equal(Number((await range(11)).s), renewed.portRangeStart);

    // 旧段没人占：原样保留。
    await sub(12, 1, 1, "expired", 10005, nowSec - DAY);
    const kept = await billing.applySubscriptionToUser(1, 1, "payment", "ORDER-2", undefined, null, 12);
    assert.equal(kept.portRangeStart, 10005);

    // 被占了又分不到新段：永久失败。
    await sub(13, 1, 2, "expired", 20000, nowSec - DAY);
    await sub(22, 2, 2, "active", 20000, nowSec + 30 * DAY);
    await assert.rejects(
      () => billing.applySubscriptionToUser(1, 2, "payment", "ORDER-3", undefined, null, 13),
      (error) => billing.isPermanentDeliveryError(error) && /端口不足/.test(error.message),
    );
    assert.equal((await query("SELECT status FROM user_subscriptions WHERE id = 13"))[0].status, "expired");
  `);
});

/** 余额买流量包和余额买套餐同一套条件：商店开关、套餐启用、商店可见。 */
test("余额买流量包要检查商店开关和套餐是否在售", () => {
  runInDatabase("ADDON_GATE_OK", String.raw`
    await exec("INSERT INTO users (id, username, password, role, balanceCents) VALUES (1, 'a', 'h', 'user', 10000)");
    await exec("INSERT INTO hosts (id, name, ip, userId, portRangeStart, portRangeEnd) VALUES (1, 'h', '127.0.0.1', 1, 10000, 10010)");
    await exec("INSERT INTO subscription_plans (id, name, durationDays, portCount, trafficLimit, isActive, isStoreVisible) VALUES (1, 'P', 30, 1, 1000, 1, 1)");
    await exec("INSERT INTO subscription_plan_hosts (planId, hostId) VALUES (1, 1)");
    await exec("INSERT INTO subscription_plan_traffic_addons (id, planId, trafficBytes, priceCents, isActive) VALUES (1, 1, 500, 100, 1)");
    await exec(
      "INSERT INTO user_subscriptions (id, userId, planId, status, source, portRangeStart, portRangeEnd, startedAt, expiresAt) VALUES (11, 1, 1, 'active', 'payment', 10000, 10000, ?, ?)",
      [nowSec - DAY, nowSec + 30 * DAY],
    );
    const caller = billingRouter.createCaller({
      req: { headers: {}, ip: "127.0.0.1", socket: {} },
      res: { clearCookie() {} },
      user: { id: 1, username: "a", role: "user", accountEnabled: true },
      authSession: null,
      authFailureReason: null,
    });
    const balance = async () => Number((await query("SELECT balanceCents FROM users WHERE id = 1"))[0].balanceCents);

    await settings.setSetting("storeEnabled", "false");
    await assert.rejects(() => caller.purchaseTrafficAddonWithBalance({ addonId: 1, subscriptionId: 11 }), /商店功能未开启/);

    await settings.setSetting("storeEnabled", "true");
    await exec("UPDATE subscription_plans SET isStoreVisible = 0 WHERE id = 1");
    await assert.rejects(() => caller.purchaseTrafficAddonWithBalance({ addonId: 1, subscriptionId: 11 }), /流量包不可购买/);
    await exec("UPDATE subscription_plans SET isStoreVisible = 1, isActive = 0 WHERE id = 1");
    await assert.rejects(() => caller.purchaseTrafficAddonWithBalance({ addonId: 1, subscriptionId: 11 }), /流量包不可购买/);
    assert.equal(await balance(), 10000, "被拒的购买不能扣钱");

    await exec("UPDATE subscription_plans SET isActive = 1 WHERE id = 1");
    const bought = await caller.purchaseTrafficAddonWithBalance({ addonId: 1, subscriptionId: 11 });
    assert.equal(Number(bought.trafficBytes), 500);
    assert.equal(await balance(), 9900);
  `);
});
