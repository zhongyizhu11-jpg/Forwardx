import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mergeManualAndPlanLimits } from "./repositories/billingRepository";

/**
 * 自建落地节点的数量上限。
 *
 * 主机授权只管「能在哪台机器上开」，管不住「开几个」—— 一个拿到主机授权的租户
 * 可以把那台机器的端口占满。这是那道刹车。
 */

test("手动填的上限算数，0 表示不限", () => {
  assert.equal(mergeManualAndPlanLimits({ manualMaxProxyInbounds: 2 }, {}).maxProxyInbounds, 2);
  assert.equal(mergeManualAndPlanLimits({ manualMaxProxyInbounds: 0 }, {}).maxProxyInbounds, 0);
  assert.equal(mergeManualAndPlanLimits({}, {}).maxProxyInbounds, 0);
});

test("套餐那一侧按订阅权限开闸，不是按转发权限", () => {
  /**
   * 这是刻意跟 maxRules 不一样的地方：落地节点是订阅那一套的配额。
   * 一个只卖转发、没开订阅的套餐，不该顺带给出落地节点额度 —— 那等于
   * 让没买订阅的人也能开落地。
   */
  const forwardOnly = mergeManualAndPlanLimits({}, {
    canAddRules: true, allowProxySubscription: false, maxProxyInbounds: 5,
  });
  assert.equal(forwardOnly.maxProxyInbounds, 0, "没开订阅的套餐不该给出落地额度");

  const withSubscription = mergeManualAndPlanLimits({}, {
    canAddRules: true, allowProxySubscription: true, maxProxyInbounds: 5,
  });
  assert.equal(withSubscription.maxProxyInbounds, 5);
});

test("手动与套餐取大；任一为不限则不限", () => {
  // 与 maxRules / maxPorts 同一套规矩，0 = 不限且不限优先。
  const both = mergeManualAndPlanLimits(
    { manualMaxProxyInbounds: 2 },
    { allowProxySubscription: true, maxProxyInbounds: 5 },
  );
  assert.equal(both.maxProxyInbounds, 5);

  const planUnlimited = mergeManualAndPlanLimits(
    { manualMaxProxyInbounds: 2 },
    { allowProxySubscription: true, maxProxyInbounds: 0 },
  );
  assert.equal(planUnlimited.maxProxyInbounds, 0, "套餐不限就是不限");
});

function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-inbound-quota-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      const repo = await import(url("server/repositories/proxyInboundRepository.ts"));

      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);

      await exec("INSERT INTO users (id, username, password, role, allowProxySubscription, maxProxyInbounds) VALUES (1, 'alice', 'hash', 'user', 1, 2)");
      await exec("INSERT INTO users (id, username, password, role, allowProxySubscription, maxProxyInbounds) VALUES (2, 'bob', 'hash', 'user', 1, 0)");
      await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (1, 'HK', '1.2.3.4', '1.2.3.4', 1)");

      const addInbound = (ownerId, port) => repo.createProxyInbound({
        userId: ownerId, hostId: 1, name: "节点" + port, protocol: "shadowsocks", port,
        transport: "tcp", security: "none",
        method: "2022-blake3-aes-128-gcm", password: "T0FXbmVkNVZuZ1E9PT0wMQ==", isEnabled: true,
      });

      ${body}

      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "quota.db") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("按归属者计数，不是按创建者", () => {
  /**
   * 管理员替租户开节点时占的是**租户**的份额。按创建者算的话，
   * 管理员替十个人各开一个，会被记成管理员开了十个 —— 配额就形同虚设。
   */
  runInDatabase(String.raw`
    await addInbound(1, 10001);
    await addInbound(1, 10002);
    await addInbound(2, 10003);

    assert.equal(await repo.countProxyInboundsByUser(1), 2);
    assert.equal(await repo.countProxyInboundsByUser(2), 1);
    // 没有任何节点的用户算 0，而不是抛错。
    assert.equal(await repo.countProxyInboundsByUser(999), 0);
  `);
});

test("新建后的计数跟着涨，删除后跟着降", () => {
  // 配额检查读的就是这个数，它不准配额就不准。
  runInDatabase(String.raw`
    const a = Number(await addInbound(1, 10001));
    assert.equal(await repo.countProxyInboundsByUser(1), 1);
    await addInbound(1, 10002);
    assert.equal(await repo.countProxyInboundsByUser(1), 2);
    await repo.deleteProxyInbound(a);
    assert.equal(await repo.countProxyInboundsByUser(1), 1);
  `);
});

test("订阅地址条数同样有上限，也按订阅权限开闸", () => {
  // 每条地址都是一份完整凭据，发出去只能靠吊销那一条收回。
  assert.equal(mergeManualAndPlanLimits({ manualMaxProxySubTokens: 3 }, {}).maxProxySubTokens, 3);
  assert.equal(mergeManualAndPlanLimits({}, {}).maxProxySubTokens, 0);

  const forwardOnly = mergeManualAndPlanLimits({}, {
    canAddRules: true, allowProxySubscription: false, maxProxySubTokens: 5,
  });
  assert.equal(forwardOnly.maxProxySubTokens, 0, "没开订阅的套餐不该给出订阅地址额度");

  const withSubscription = mergeManualAndPlanLimits({}, {
    canAddRules: true, allowProxySubscription: true, maxProxySubTokens: 5,
  });
  assert.equal(withSubscription.maxProxySubTokens, 5);
});

test("两种权限互不牵连：只给订阅的用户仍然拿得到订阅额度", () => {
  /**
   * 这条守的是解绑之后的完整性 —— 一个零转发、只买订阅的租户，
   * 他的落地节点额度和订阅地址额度都得照常算出来，否则「只给订阅」等于没给。
   */
  const merged = mergeManualAndPlanLimits({}, {
    canAddRules: false,
    allowProxySubscription: true,
    maxProxyInbounds: 2,
    maxProxySubTokens: 1,
  });
  assert.equal(merged.canAddRules, false);
  assert.equal(merged.allowProxySubscription, true);
  assert.equal(merged.maxProxyInbounds, 2);
  assert.equal(merged.maxProxySubTokens, 1);
});
