import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 套餐附带落地节点：买了自动发凭据，到期 / 取消 / 换套餐自动收回。
 *
 * 这一组守两件事：
 *
 * 1. **自动**。商家上架时勾好节点，之后不该再有任何一步手工分配 —— 下单、
 *    后台分配、续期、到期清扫都走同一个「重算权益」入口。
 * 2. **手工分的不被顺手删掉**。管理员单独分给某人的节点，跟套餐带的是两回事：
 *    套餐同步不能把它冲掉，反过来撤套餐也不该把手工那份带走。
 */
function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-plan-node-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      const billing = await import(url("server/repositories/billingRepository.ts"));
      const shares = await import(url("server/repositories/proxySubscriptionRepository.ts"));
      const inbounds = await import(url("server/repositories/proxyInboundRepository.ts"));

      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      const query = (sql, params = []) => runtime.queryRaw(sql, params);

      await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (1, 'alice', 'hash', 'admin', 1)");
      await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (2, 'bob', 'hash', 'user', 1)");
      await exec("INSERT INTO hosts (id, name, ip, agentToken, userId) VALUES (10, 'hk', '203.0.113.9', 'tok', 1)");
      await exec("INSERT INTO forward_groups (id, name, groupMode, targetIp, userId) VALUES (5, '端口转发', 'port', '203.0.113.20', 1)");

      /** alice 名下的一个多凭据入站，返回代表这个端口的那条节点。 */
      const makeNode = async (port, name) => {
        const id = Number(await inbounds.createProxyInbound({
          userId: 1, hostId: 10, name, protocol: "vless", port,
          transport: "tcp", security: "reality",
          uuid: "11111111-2222-3333-4444-555555555555", isEnabled: true,
        }));
        await inbounds.replaceProxyInboundUsers(id, [
          { id: 0, name: "自己", uuid: "aaaaaaaa-bbbb-cccc-dddd-" + String(port).padStart(12, "0"), password: "" },
        ]);
        await inbounds.syncProxyNodeFromInbound(id);
        const rows = await query("SELECT id FROM proxy_nodes WHERE inboundId = ? ORDER BY id", [id]);
        return { inboundId: id, nodeId: Number(rows[0].id) };
      };

      const makePlan = async (proxyNodeIds) => {
        const plan = await billing.createSubscriptionPlan({
          name: "带节点的套餐", priceCents: 1000, currency: "CNY", durationDays: 30,
          portCount: 10, maxRules: 10, allowProxySubscription: true, isActive: true,
        }, [10], [], [], [], proxyNodeIds);
        return Number(plan.id);
      };

      const credentialsFor = async (inboundId, userId) =>
        (await inbounds.getProxyInboundUsers(inboundId)).filter((user) => Number(user.sharedUserId) === Number(userId));

      ${body}

      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "plan.db") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("分配套餐就自动发凭据，节点直接进他的订阅", () => {
  runInDatabase(String.raw`
    const hk = await makeNode(443, "HK");
    const planId = await makePlan([hk.nodeId]);

    await billing.applySubscriptionToUser(2, planId, "admin");

    assert.equal((await credentialsFor(hk.inboundId, 2)).length, 1, "买了就该有一份自己的凭据");
    const nodes = await shares.getProxyNodesForSubscription(2);
    assert.equal(nodes.length, 1, "节点要直接出现在他的订阅里");
    assert.equal(Number(nodes[0].inboundId), hk.inboundId);
  `);
});

test("套餐到期，凭据自动收回", () => {
  runInDatabase(String.raw`
    const hk = await makeNode(443, "HK");
    const planId = await makePlan([hk.nodeId]);
    await billing.applySubscriptionToUser(2, planId, "admin");
    assert.equal((await credentialsFor(hk.inboundId, 2)).length, 1);

    // 把订阅改成昨天过期，再跑一次到期清扫 —— 这是定时任务走的那条路。
    await exec("UPDATE user_subscriptions SET expiresAt = ? WHERE userId = 2", [Math.floor(Date.now() / 1000) - 3600]);
    await billing.expireUserSubscriptions();

    assert.equal((await credentialsFor(hk.inboundId, 2)).length, 0, "到期就该收回，否则他存下的订阅照样能连");
    assert.equal((await shares.getProxyNodesForSubscription(2)).length, 0);
  `);
});

test("取消订阅，凭据跟着走", () => {
  runInDatabase(String.raw`
    const hk = await makeNode(443, "HK");
    const planId = await makePlan([hk.nodeId]);
    const applied = await billing.applySubscriptionToUser(2, planId, "admin");
    assert.equal((await credentialsFor(hk.inboundId, 2)).length, 1);

    const rows = await query("SELECT id FROM user_subscriptions WHERE userId = 2");
    await billing.cancelUserSubscription(Number(rows[0].id));
    assert.equal((await credentialsFor(hk.inboundId, 2)).length, 0);
  `);
});

test("套餐改挂别的节点，同步之后旧的收回、新的发出", () => {
  runInDatabase(String.raw`
    const hk = await makeNode(443, "HK");
    const jp = await makeNode(444, "JP");
    const planId = await makePlan([hk.nodeId]);
    await billing.applySubscriptionToUser(2, planId, "admin");
    assert.equal((await credentialsFor(hk.inboundId, 2)).length, 1);

    await billing.updateSubscriptionPlan(planId, {}, undefined, undefined, undefined, undefined, [jp.nodeId]);
    await billing.syncPlanSubscribers(planId);

    assert.equal((await credentialsFor(hk.inboundId, 2)).length, 0, "撤下的节点要收回");
    assert.equal((await credentialsFor(jp.inboundId, 2)).length, 1, "新挂的节点要发出去");
  `);
});

test("套餐同步不会删掉管理员手工分的那份", () => {
  runInDatabase(String.raw`
    const hk = await makeNode(443, "HK");
    const jp = await makeNode(444, "JP");
    const planId = await makePlan([hk.nodeId]);

    // 手工单独分一个 JP 给他，跟套餐无关。
    await shares.setProxyNodeSharesForUser(2, [jp.nodeId], { label: "bob" });
    await billing.applySubscriptionToUser(2, planId, "admin");

    assert.equal((await credentialsFor(jp.inboundId, 2)).length, 1, "手工那份不能被套餐同步冲掉");
    assert.equal((await credentialsFor(hk.inboundId, 2)).length, 1, "套餐那份也要发出来");
    assert.equal((await shares.getProxyNodesForSubscription(2)).length, 2);
  `);
});

test("手工改分享不会带走套餐给的那份", () => {
  runInDatabase(String.raw`
    const hk = await makeNode(443, "HK");
    const jp = await makeNode(444, "JP");
    const planId = await makePlan([hk.nodeId]);
    await billing.applySubscriptionToUser(2, planId, "admin");

    // 管理员在用户页把手工分享改成只有 JP —— 套餐带的 HK 不该受影响。
    await shares.setProxyNodeSharesForUser(2, [jp.nodeId], { label: "bob" });

    assert.equal((await credentialsFor(hk.inboundId, 2)).length, 1, "套餐给的那份要留着");
    assert.equal((await credentialsFor(jp.inboundId, 2)).length, 1);
  `);
});

test("同一个节点既手工分又被套餐带，撤掉套餐不该让他断线", () => {
  runInDatabase(String.raw`
    const hk = await makeNode(443, "HK");
    const planId = await makePlan([hk.nodeId]);
    await shares.setProxyNodeSharesForUser(2, [hk.nodeId], { label: "bob" });
    await billing.applySubscriptionToUser(2, planId, "admin");

    // 套餐撤掉这个节点
    await billing.updateSubscriptionPlan(planId, {}, undefined, undefined, undefined, undefined, []);
    await billing.syncPlanSubscribers(planId);

    assert.equal((await credentialsFor(hk.inboundId, 2)).length, 1, "手工那一路还在，凭据不能收");
    const rows = await query("SELECT source FROM proxy_node_shares WHERE userId = 2");
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0].source), "manual", "剩下的这条是手工那一路");
  `);
});

test("管理端选择框勾的是代表整个端口的那条，不是他自己那条", () => {
  runInDatabase(String.raw`
    const hk = await makeNode(443, "HK");
    await shares.setProxyNodeSharesForUser(2, [hk.nodeId], { label: "bob" });

    // 他实际拿到的是自己那条派生节点，而选项列表里放的是 hk.nodeId。
    // 两边对不上的话，选择框显示成一个都没选，管理员一保存就把他的凭据静默收走。
    const selection = await shares.getProxyNodeShareSelectionForUser(2);
    assert.deepEqual(selection, [hk.nodeId]);

    const options = await shares.getProxyNodeShareOptions();
    assert.ok(options.some((row) => Number(row.id) === hk.nodeId), "勾中的那条必须在选项里");

    // 拿这个勾选状态原样保存一次，凭据不能变 —— 幂等才敢让人随手点保存。
    const before = (await inbounds.getProxyInboundUsers(hk.inboundId)).find((u) => Number(u.sharedUserId) === 2);
    await shares.setProxyNodeSharesForUser(2, selection, { label: "bob" });
    const after = (await inbounds.getProxyInboundUsers(hk.inboundId)).find((u) => Number(u.sharedUserId) === 2);
    assert.equal(after.id, before.id);
    assert.equal(after.uuid, before.uuid);
  `);
});

test("开通订阅权限就自动有一条订阅地址，删掉了不会被偷偷加回来", () => {
  runInDatabase(String.raw`
    const hk = await makeNode(443, "HK");
    const planId = await makePlan([hk.nodeId]);
    await billing.applySubscriptionToUser(2, planId, "admin");

    const tokens = await query("SELECT id, name FROM proxy_sub_tokens WHERE userId = 2");
    assert.equal(tokens.length, 1, "买了套餐就该有一条地址，不该还要自己点一下新建");

    // 他自己删掉之后，再来一次权益重算不该又冒出来一条。
    await exec("DELETE FROM proxy_sub_tokens WHERE userId = 2");
    await billing.syncPlanSubscribers(planId);
    assert.equal((await query("SELECT id FROM proxy_sub_tokens WHERE userId = 2")).length, 0);
  `);
});
