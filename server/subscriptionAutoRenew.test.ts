import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 余额自动续费。
 *
 * 「到期 → 断服 → 客户发现 → 手工去付 → 等回调」这一串每一步都在掉人，而余额
 * 本来就躺在账上。这一组守的是它不能变成另一种事故：
 *
 * - 只在快到期时扣，不提前半个月就把钱划走；
 * - 余额不够就安静跳过、照常到期，不能扣成负数；
 * - 同一天不重复扣 —— 调度器是几分钟一轮的。
 */
function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-auto-renew-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      const billing = await import(url("server/repositories/billingRepository.ts"));

      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      const query = (sql, params = []) => runtime.queryRaw(sql, params);

      await exec("INSERT INTO users (id, username, password, role, allowProxySubscription, balanceCents) VALUES (1, 'alice', 'h', 'admin', 1, 0)");
      await exec("INSERT INTO users (id, username, password, role, allowProxySubscription, balanceCents) VALUES (2, 'bob', 'h', 'user', 1, 5000)");
      await exec("INSERT INTO hosts (id, name, ip, agentToken, userId) VALUES (10, 'hk', '203.0.113.9', 'tok', 1)");

      const makePlan = async (priceCents) => Number((await billing.createSubscriptionPlan({
        name: "月付", priceCents, currency: "CNY", durationDays: 30,
        portCount: 10, maxRules: 10, allowProxySubscription: true,
        isActive: true, isStoreVisible: true,
      }, [10], [], [], [], [])).id);

      /** 把这条订阅的到期时间挪到 N 小时之后。 */
      const expireIn = async (hours) => exec(
        "UPDATE user_subscriptions SET expiresAt = ? WHERE userId = 2",
        [Math.floor(Date.now() / 1000) + Math.round(hours * 3600)],
      );
      const balanceOf = async (userId) => Number((await query("SELECT balanceCents FROM users WHERE id = ?", [userId]))[0].balanceCents);
      const expiresAtOf = async () => Number((await query("SELECT expiresAt FROM user_subscriptions WHERE userId = 2"))[0].expiresAt);

      ${body}

      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "renew.db") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("快到期 + 开了自动续费 + 余额够：自动扣款续一期", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000);
    await billing.applySubscriptionToUser(2, planId, "balance");
    await exec("UPDATE user_subscriptions SET autoRenew = 1 WHERE userId = 2");
    await expireIn(6);
    const before = await expiresAtOf();

    const result = await billing.runSubscriptionAutoRenew();
    assert.equal(result.renewed, 1);
    assert.equal(await balanceOf(2), 4000, "该扣掉一期的钱");
    assert.ok(await expiresAtOf() > before, "到期时间要往后走");
    assert.equal((await query("SELECT status FROM user_subscriptions WHERE userId = 2"))[0].status, "active");
  `);
});

test("没开自动续费的不动", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000);
    await billing.applySubscriptionToUser(2, planId, "balance");
    await expireIn(6);

    const result = await billing.runSubscriptionAutoRenew();
    assert.equal(result.renewed, 0);
    assert.equal(await balanceOf(2), 5000, "没开的人一分钱都不能动");
  `);
});

test("离到期还早的不提前扣", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000);
    await billing.applySubscriptionToUser(2, planId, "balance");
    await exec("UPDATE user_subscriptions SET autoRenew = 1 WHERE userId = 2");
    await expireIn(24 * 10);

    // 提前十天把钱划走，客户会觉得是乱扣。
    const result = await billing.runSubscriptionAutoRenew();
    assert.equal(result.renewed, 0);
    assert.equal(await balanceOf(2), 5000);
  `);
});

test("余额不够就安静跳过，照常到期，不会扣成负数", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(9000);
    await billing.applySubscriptionToUser(2, planId, "admin");
    await exec("UPDATE user_subscriptions SET autoRenew = 1 WHERE userId = 2");
    await expireIn(6);

    const result = await billing.runSubscriptionAutoRenew();
    assert.equal(result.renewed, 0);
    assert.equal(result.failed, 1);
    assert.equal(await balanceOf(2), 5000, "余额不能被扣成负数");
  `);
});

test("同一天不重复扣 —— 调度器是几分钟一轮的", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000);
    await billing.applySubscriptionToUser(2, planId, "balance");
    await exec("UPDATE user_subscriptions SET autoRenew = 1 WHERE userId = 2");
    await expireIn(6);

    await billing.runSubscriptionAutoRenew();
    const afterFirst = await balanceOf(2);
    // 续过之后到期时间已经推远了，就算再跑也不该进入扣款分支；
    // 这里再把它拉回快到期，验证日键确实拦住了第二次。
    await expireIn(6);
    const second = await billing.runSubscriptionAutoRenew();
    assert.equal(second.renewed, 0);
    assert.equal(await balanceOf(2), afterFirst, "同一天第二轮不能再扣一次");
  `);
});

test("套餐已经下架就不自动续 —— 下架的东西不该继续卖", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000);
    await billing.applySubscriptionToUser(2, planId, "balance");
    await exec("UPDATE user_subscriptions SET autoRenew = 1 WHERE userId = 2");
    await exec("UPDATE subscription_plans SET isActive = 0 WHERE id = ?", [planId]);
    await expireIn(6);

    const result = await billing.runSubscriptionAutoRenew();
    assert.equal(result.renewed, 0);
    assert.equal(await balanceOf(2), 5000);
  `);
});

test("开关只改得动自己的订阅", () => {
  runInDatabase(String.raw`
    const planId = await makePlan(1000);
    await billing.applySubscriptionToUser(2, planId, "balance");
    const id = Number((await query("SELECT id FROM user_subscriptions WHERE userId = 2"))[0].id);

    assert.equal(await billing.setUserSubscriptionAutoRenew(id, 2, true), true);
    assert.equal(Number((await query("SELECT autoRenew FROM user_subscriptions WHERE id = ?", [id]))[0].autoRenew), 1);

    // 别人的订阅：改不动，也不能报成功。
    assert.equal(await billing.setUserSubscriptionAutoRenew(id, 1, false), false);
    assert.equal(Number((await query("SELECT autoRenew FROM user_subscriptions WHERE id = ?", [id]))[0].autoRenew), 1);
  `);
});
