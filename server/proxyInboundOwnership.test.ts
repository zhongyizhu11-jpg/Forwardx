import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 多端口多用户：一台主机上的多个入站端口分别归不同用户。
 *
 * 归属这一列决定三件事 —— 节点进谁的订阅、流量扣谁的套餐、谁在面板上看得到它。
 * 三件事都落在 proxy_inbounds.userId 上，所以这里守的就是它：派生节点要跟着归属走，
 * 列表要按归属分流，换归属时要就地改那条节点而不是留一条给原主人。
 */
function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-inbound-owner-"));
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
      // SELECT 要走 queryRaw —— executeRaw 在 sqlite 上是 .run()，取不到行。
      const query = (sql, params = []) => runtime.queryRaw(sql, params);

      await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (1, 'boss', 'hash', 'admin', 0)");
      await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (2, 'alice', 'hash', 'user', 1)");
      await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (3, 'bob', 'hash', 'user', 1)");
      // 主机归管理员，两个端口分租给 alice 和 bob。
      await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (1, 'HK', '1.2.3.4', '1.2.3.4', 1)");

      /** 建一个 VLESS+REALITY 入站，归 ownerId，带一个用户。 */
      const makeInbound = async (ownerId, name, port) => {
        const id = Number(await repo.createProxyInbound({
          userId: ownerId,
          hostId: 1,
          name,
          protocol: "vless",
          port,
          transport: "tcp",
          security: "reality",
          serverName: "dl.google.com",
          realityPrivateKey: "cHJpdmF0ZS1rZXktMzItYnl0ZXMtZm9yLXRlc3Rpbmc",
          realityPublicKey: "cHVibGljLWtleS0zMi1ieXRlcy1mb3ItdGVzdGluZzEy",
          realityShortId: "a1b2c3d4",
          isEnabled: true,
        }));
        await repo.replaceProxyInboundUsers(id, [{ id: 0, name: "默认", uuid: "11111111-2222-3333-4444-555555555555", password: "" }]);
        await repo.syncProxyNodeFromInbound(id);
        return id;
      };

      const nodesOf = (inboundId) => query("SELECT id, userId, inboundUserId FROM proxy_nodes WHERE inboundId = ?", [inboundId]);

      ${body}

      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "owner.db") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("派生节点归入站的所有者，而不是建它的管理员", () => {
  // 归错人的后果是节点进了管理员的订阅、流量扣管理员的额度，
  // 而付钱的那个用户什么都看不到 —— 分租直接不成立。
  runInDatabase(String.raw`
    const aliceInbound = await makeInbound(2, "alice 的端口", 10001);
    const bobInbound = await makeInbound(3, "bob 的端口", 10002);

    const aliceNodes = await nodesOf(aliceInbound);
    const bobNodes = await nodesOf(bobInbound);
    assert.equal(aliceNodes.length, 1);
    assert.equal(bobNodes.length, 1);
    assert.equal(Number(aliceNodes[0].userId), 2);
    assert.equal(Number(bobNodes[0].userId), 3);
  `);
});

test("按归属分流：普通用户只看到自己的入站，管理员看到全量", () => {
  runInDatabase(String.raw`
    const aliceInbound = await makeInbound(2, "alice 的端口", 10001);
    const bobInbound = await makeInbound(3, "bob 的端口", 10002);

    const mine = await repo.getProxyInboundsByUser(2);
    assert.deepEqual(mine.map((row) => Number(row.id)), [aliceInbound]);

    const all = await repo.getAllProxyInbounds();
    assert.deepEqual(all.map((row) => Number(row.id)).sort(), [aliceInbound, bobInbound].sort());
  `);
});

test("流量归属查得到每个端口是谁的", () => {
  // 上报按端口进来，扣谁的套餐全靠这张映射 —— 错了就会扣到别人头上。
  runInDatabase(String.raw`
    const aliceInbound = await makeInbound(2, "alice 的端口", 10001);
    const bobInbound = await makeInbound(3, "bob 的端口", 10002);

    const owners = await repo.getProxyInboundOwnersByIds([aliceInbound, bobInbound]);
    assert.equal(owners.get(aliceInbound), 2);
    assert.equal(owners.get(bobInbound), 3);
  `);
});

test("换归属时那条派生节点就地换主人，不会给原主人留一条", () => {
  /**
   * 这条是换归属最容易出错的地方：如果按 userId 去找已有节点，换主人后会找不到、
   * 于是新建一条，而原主人那条留在他的订阅里继续能连 —— 端口已经算别人的流量了，
   * 原主人却还在用。所以对齐必须按 inboundUserId。
   */
  runInDatabase(String.raw`
    const inboundId = await makeInbound(2, "先给 alice", 10001);
    const before = await nodesOf(inboundId);
    assert.equal(before.length, 1);
    assert.equal(Number(before[0].userId), 2);

    await repo.updateProxyInbound(inboundId, { userId: 3 });
    await repo.syncProxyNodeFromInbound(inboundId);

    const after = await nodesOf(inboundId);
    assert.equal(after.length, 1, "换归属不该多出一条节点");
    assert.equal(Number(after[0].id), Number(before[0].id), "应该就地改那条，而不是删了重建");
    assert.equal(Number(after[0].userId), 3);

    // 原主人名下不该再有这个入站派生出来的任何节点。
    const leftovers = await query("SELECT COUNT(*) AS n FROM proxy_nodes WHERE userId = 2");
    assert.equal(Number(leftovers[0].n), 0);
  `);
});
