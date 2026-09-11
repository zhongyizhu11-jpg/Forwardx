import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 节点分享：把我的某几个节点放进别人的订阅，所有权不变。
 *
 * 与「归属用户」的分工是这一组用例要守住的东西 —— 归属是整份转给对方，
 * 分享是同一份同时出现在两个人的订阅里。
 */
function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-node-share-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      const repo = await import(url("server/repositories/proxySubscriptionRepository.ts"));

      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      const query = (sql, params = []) => runtime.queryRaw(sql, params);

      // alice 是节点主人，bob 只租节点。
      await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (1, 'alice', 'hash', 'admin', 1)");
      await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (2, 'bob', 'hash', 'user', 1)");

      const makeNode = async (userId, name, port, extra = {}) => Number(await repo.createProxyNode({
        userId, name, protocol: "vless", address: "1.2.3.4", port,
        uuid: "11111111-2222-3333-4444-555555555555", transport: "tcp", tls: true,
        isEnabled: true, ...extra,
      }));

      ${body}

      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "share.db") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("分享给谁，谁的订阅里就有这个节点", () => {
  runInDatabase(String.raw`
    const nodeId = await makeNode(1, "HK-01", 443);
    await repo.setProxyNodeSharesForUser(2, [nodeId]);

    const plan = await repo.buildProxySubscriptionPlanForUser(2);
    const entries = plan.entries.filter((entry) => entry.templateId === nodeId);
    assert.equal(entries.length, 1, "bob 的订阅里应当有这个节点");
    assert.equal(entries[0].kind, "direct", "bob 名下没有绑它的转发，只能是直连");
  `);
});

test("主人自己没开直连，分享给别人照样能连", () => {
  /**
   * includeDirect 默认是关的：落地 IP 进订阅，被墙就要重搭。但分享的整个意思
   * 就是让对方连这个落地 —— 不强制打开的话，界面显示已分享，对方订阅里却什么
   * 都没有，而且看不出少了哪一步。
   */
  runInDatabase(String.raw`
    const nodeId = await makeNode(1, "HK-01", 443, { includeDirect: false });
    await repo.setProxyNodeSharesForUser(2, [nodeId]);

    const mine = await repo.buildProxySubscriptionPlanForUser(1);
    assert.equal(mine.entries.filter((e) => e.templateId === nodeId).length, 0, "主人自己没开直连，他的订阅里就不该有");

    const theirs = await repo.buildProxySubscriptionPlanForUser(2);
    assert.equal(theirs.entries.filter((e) => e.templateId === nodeId).length, 1, "分享给对方的那一份要能连");
  `);
});

test("分享不转让所有权", () => {
  // 归属用户是把整份转给对方；分享之后节点仍然记在主人名下，流量也还是主人的。
  runInDatabase(String.raw`
    const nodeId = await makeNode(1, "HK-01", 443);
    await repo.setProxyNodeSharesForUser(2, [nodeId]);
    const rows = await query("SELECT userId FROM proxy_nodes WHERE id = ?", [nodeId]);
    assert.equal(Number(rows[0].userId), 1);
    const owned = await repo.getProxyNodesByUser(2);
    assert.equal(owned.length, 0, "分享来的节点不算 bob 名下的");
  `);
});

test("分享带着的前置代理引用会被断掉", () => {
  /**
   * frontProxyId 指向主人自己的另一行。id 全表自增，收方名下恰好有同号节点时，
   * 引用就落到别人的机器上了。
   */
  runInDatabase(String.raw`
    const frontId = await makeNode(1, "前置", 8443, { includeDirect: true });
    const nodeId = await makeNode(1, "HK-01", 443, { frontProxyId: frontId });
    await repo.setProxyNodeSharesForUser(2, [nodeId]);

    const plan = await repo.buildProxySubscriptionPlanForUser(2);
    const entry = plan.entries.find((e) => e.templateId === nodeId);
    assert.ok(entry, "节点本身要在");
    assert.equal(entry.frontTemplateId, 0, "分享出去的那一份不该挂前置代理");
    assert.equal(plan.entries.filter((e) => e.templateId === frontId).length, 0, "没分享的前置节点不该跟着漏过去");
  `);
});

test("自己的节点分享给自己是空操作", () => {
  // 落进来的话对方订阅里会出现两条一模一样的线路。
  runInDatabase(String.raw`
    const nodeId = await makeNode(1, "HK-01", 443, { includeDirect: true });
    await repo.setProxyNodeSharesForUser(1, [nodeId]);
    assert.deepEqual(await repo.getProxyNodeIdsSharedToUser(1), []);

    const plan = await repo.buildProxySubscriptionPlanForUser(1);
    assert.equal(plan.entries.filter((e) => e.templateId === nodeId).length, 1, "只该有一条");
  `);
});

test("重新设置是全量替换", () => {
  runInDatabase(String.raw`
    const a = await makeNode(1, "HK-01", 443);
    const b = await makeNode(1, "HK-02", 444);
    await repo.setProxyNodeSharesForUser(2, [a, b]);
    assert.equal((await repo.getProxyNodeIdsSharedToUser(2)).length, 2);

    await repo.setProxyNodeSharesForUser(2, [b]);
    assert.deepEqual(await repo.getProxyNodeIdsSharedToUser(2), [b]);
  `);
});

test("节点删掉，分享记录跟着删", () => {
  /**
   * 留着的话对方订阅指向一个不存在的节点 id，而管理端还显示「已分享给 1 人」——
   * 从界面上看不出人已经拿不到了。
   */
  runInDatabase(String.raw`
    const nodeId = await makeNode(1, "HK-01", 443);
    await repo.setProxyNodeSharesForUser(2, [nodeId]);
    await repo.deleteProxyNode(nodeId);
    assert.deepEqual(await repo.getProxyNodeIdsSharedToUser(2), []);
    const plan = await repo.buildProxySubscriptionPlanForUser(2);
    assert.equal(plan.entries.length, 0);
  `);
});

test("停用的节点不会分享进别人的订阅", () => {
  // 主人停用就是「这台先别用了」，对收方也得成立。
  runInDatabase(String.raw`
    const nodeId = await makeNode(1, "HK-01", 443, { isEnabled: false });
    await repo.setProxyNodeSharesForUser(2, [nodeId]);
    const plan = await repo.buildProxySubscriptionPlanForUser(2);
    assert.equal(plan.entries.length, 0);
  `);
});

test("订阅文档与订阅计划取的是同一批节点", () => {
  /**
   * 两处一旦用了不同的模板集合，订阅里会出现「策略组里有名字、节点列表里没有
   * 这个节点」这种坏配置 —— Clash 会拒绝整份配置，报的是「订阅导入失败」。
   */
  runInDatabase(String.raw`
    const nodeId = await makeNode(1, "HK-01", 443);
    await repo.setProxyNodeSharesForUser(2, [nodeId]);
    const doc = await repo.getProxySubscriptionDocumentForUser(2);
    assert.equal(doc.nodes.length, 1, "文档里要有这个分享来的节点");
    assert.equal(doc.nodes[0].address, "1.2.3.4");
  `);
});

test("多个人可以拿到同一个节点", () => {
  // 只租一两个落地、不值得为每人单开端口时就是这么用的。
  runInDatabase(String.raw`
    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (3, 'carol', 'hash', 'user', 1)");
    const nodeId = await makeNode(1, "HK-01", 443);
    await repo.setProxyNodeSharesForUser(2, [nodeId]);
    await repo.setProxyNodeSharesForUser(3, [nodeId]);
    assert.deepEqual(await repo.getProxyNodeShareRecipients(nodeId), [2, 3]);
    for (const userId of [2, 3]) {
      const plan = await repo.buildProxySubscriptionPlanForUser(userId);
      assert.equal(plan.entries.length, 1, "两个人都该拿到");
    }
  `);
});
