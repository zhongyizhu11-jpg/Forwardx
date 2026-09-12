import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 自建节点建完要能出现在订阅里。
 *
 * 这一段的说明写的是「在自己的主机上开节点，自动进订阅」。派生出来的节点若
 * includeDirect 是关的、又没绑转发，它在订阅里一条都不会出现 —— 那句话就成了假的，
 * 而用户从界面上看不出少了哪一步。
 */
function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-inbound-sub-"));
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
      const query = (sql, params = []) => runtime.queryRaw(sql, params);

      await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (1, 'alice', 'hash', 'user', 1)");
      await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (1, 'HK', '1.2.3.4', '1.2.3.4', 1)");

      const makeInbound = async (id, port) => {
        const created = Number(await repo.createProxyInbound({
          userId: 1, hostId: 1, name: "自建" + id, protocol: "shadowsocks", port,
          transport: "tcp", security: "none",
          method: "2022-blake3-aes-128-gcm", password: "T0FXbmVkNVZuZ1E9PT0wMQ==",
          isEnabled: true,
        }));
        await repo.syncProxyNodeFromInbound(created);
        return created;
      };

      ${body}

      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "sub.db") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("新建的自建节点默认就在订阅里", () => {
  // 「自动进订阅」是这一段的承诺。默认关着的话，建完什么也不会发生。
  runInDatabase(String.raw`
    const id = await makeInbound(1, 10001);
    const rows = await query("SELECT includeDirect, inboundId FROM proxy_nodes WHERE inboundId = ?", [id]);
    assert.equal(rows.length, 1, "应当派生出一条客户端节点");
    assert.ok(rows[0].includeDirect === 1 || rows[0].includeDirect === true, "派生节点应当默认加进订阅");
  `);
});

test("用户手动关掉之后，再保存入站不会把它打开", () => {
  /**
   * 默认值只在新建时给。更新时也塞一遍的话，用户每次改个端口都会发现
   * 自己关掉的开关又被打开了 —— 而且看不出是谁打开的。
   */
  runInDatabase(String.raw`
    const id = await makeInbound(1, 10001);
    await exec("UPDATE proxy_nodes SET includeDirect = 0 WHERE inboundId = ?", [id]);

    await repo.updateProxyInbound(id, { port: 10002 });
    await repo.syncProxyNodeFromInbound(id);

    const rows = await query("SELECT includeDirect, port FROM proxy_nodes WHERE inboundId = ?", [id]);
    assert.equal(Number(rows[0].port), 10002, "端口应当已经跟着改了");
    assert.ok(rows[0].includeDirect === 0 || rows[0].includeDirect === false, "用户关掉的开关不该被重新打开");
  `);
});

test("派生节点的订阅状态查得到，供「新建节点」那一段给出开关入口", () => {
  runInDatabase(String.raw`
    const a = await makeInbound(1, 10001);
    const b = await makeInbound(2, 10002);
    await exec("UPDATE proxy_nodes SET includeDirect = 0 WHERE inboundId = ?", [b]);

    const map = await repo.getProxyInboundDerivedNodes([a, b]);
    assert.equal(map.get(a).includeDirect, true);
    assert.equal(map.get(b).includeDirect, false);
    assert.equal(map.get(a).ids.length, 1);

    // 没派生出节点的入站也要给一个空条目，调用方直接遍历。
    const empty = await repo.getProxyInboundDerivedNodes([999]);
    assert.deepEqual(empty.get(999), { ids: [], nodes: [], includeDirect: false });

    // nodes 里带着 inboundUserId：界面靠它把「哪条节点是哪份凭据」对上号，
    // 光有一串 id 的话，凭据一增一删就会对错人。
    assert.deepEqual(map.get(a).nodes.map((node) => Number(node.id)), map.get(a).ids);
    assert.ok(map.get(a).nodes.every((node) => Number.isInteger(Number(node.inboundUserId))));
  `);
});

test("派生节点带着 inboundId，界面据此把它排除出「落地节点」那一段", () => {
  /**
   * 两处都列的话同一个节点会出现两次；而且「落地节点」的编辑是按「换一条节点
   *链接」设计的，派生节点没有链接，点进去只会得到一句「请粘贴落地机的节点链接」——
   * 一个必然失败的入口。
   */
  runInDatabase(String.raw`
    const id = await makeInbound(1, 10001);
    await exec("INSERT INTO proxy_nodes (userId, name, protocol, address, port, isEnabled) VALUES (1, '粘进来的', 'vless', 'x.example.com', 443, 1)");

    const all = await query("SELECT name, inboundId, sourceLink FROM proxy_nodes ORDER BY id");
    assert.equal(all.length, 2);
    const derived = all.find((row) => Number(row.inboundId) > 0);
    const pasted = all.find((row) => Number(row.inboundId) === 0);
    assert.ok(derived, "派生节点应当带 inboundId");
    assert.ok(pasted, "粘进来的节点 inboundId 应为 0");
    // 派生节点没有 sourceLink —— 这正是那个编辑入口必然失败的原因。
    assert.ok(!derived.sourceLink, "派生节点不该有 sourceLink");
  `);
});

test("分享链接一个用户一条，凭据互不相同", () => {
  /**
   * 多用户入站的每个人拿到的必须是自己那份凭据。串了的话两个人共用一条身份 ——
   * 吊销其中一个会把另一个也踢下线，而界面上两行看着是独立的。
   */
  runInDatabase(String.raw`
    const shared = await import(url("shared/proxyInbound.ts"));
    const node = await import(url("shared/proxyNode.ts"));

    const id = Number(await repo.createProxyInbound({
      userId: 1, hostId: 1, name: "多用户", protocol: "vless", port: 10443,
      transport: "tcp", security: "reality", serverName: "dl.google.com",
      realityPrivateKey: "cHJpdmF0ZS1rZXktMzItYnl0ZXMtZm9yLXRlc3Rpbmc",
      realityPublicKey: "cHVibGljLWtleS0zMi1ieXRlcy1mb3ItdGVzdGluZzEy",
      realityShortId: "a1b2c3d4", isEnabled: true,
    }));
    await repo.replaceProxyInboundUsers(id, [
      { id: 0, name: "小王", uuid: "11111111-1111-1111-1111-111111111111", password: "" },
      { id: 0, name: "小李", uuid: "22222222-2222-2222-2222-222222222222", password: "" },
    ]);

    const inbound = await repo.loadProxyInbound(id);
    const address = await repo.getProxyInboundAddress(1);
    assert.ok(address, "主机应当有可用地址");

    const links = shared.proxyNodesFromInbound(inbound, { address }).map(({ user, node: n }) => ({
      userName: user ? user.name : "",
      link: node.formatProxyNodeLink(n),
    }));
    assert.equal(links.length, 2, "两个用户应当各得一条链接");

    const uuids = new Set();
    for (const item of links) {
      const back = node.parseProxyNodeLink(item.link);
      assert.ok(back.ok, item.userName + " 的链接应当能回读");
      uuids.add(back.node.uuid);
      // 公钥要在链接里，否则客户端握手必失败。
      assert.equal(back.node.realityPublicKey, "cHVibGljLWtleS0zMi1ieXRlcy1mb3ItdGVzdGluZzEy");
    }
    assert.equal(uuids.size, 2, "两个用户的凭据必须互不相同");
  `);
});
