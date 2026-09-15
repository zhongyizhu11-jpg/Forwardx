import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 主机换了入口地址，订阅里那条节点也要跟着换。
 *
 * 派生节点的地址是保存入站那一刻抄下来的。主机之后换 IP、填了自定义入口、开了
 * DDNS 域名，转发链和隧道都会被 refreshHostAddressRuntime 改到新地址，Agent 也会
 * 收到新配置 —— 只有订阅里那一条留在原地。客户端拉到手连不上，而面板上转发、
 * 隧道、Agent 全是绿的，没有一处指向真正的原因。
 *
 * 反过来也要验：地址没变时这条链路必须什么都不做。它挂在每一条地址变更路径上，
 * 每次都把整机的入站重新派生一遍的话，改个备注都要重写一遍订阅。
 */
test("SQLite 主机入口地址变更后，派生订阅节点跟着改；地址没变时不重写", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-node-addr-"));
  const databasePath = path.join(directory, "node-addr.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const inbounds = await import(url("server/repositories/proxyInboundRepository.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);

    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (2, 'tenant', 'hash', 'user', 1)");
    await exec("INSERT INTO hosts (id, name, ip, ipv4, agentToken, userId) VALUES (10, '落地', '203.0.113.10', '203.0.113.10', 'tok10', 2)");

    const inboundId = Number(await inbounds.createProxyInbound({
      userId: 2, hostId: 10, name: "自建入站", protocol: "vless", port: 443,
      transport: "tcp", security: "reality", isEnabled: true,
      realityPrivateKey: "priv", realityPublicKey: "pub", realityShortId: "ab",
      realityDest: "www.example.com:443", serverName: "www.example.com",
    }));
    await inbounds.replaceProxyInboundUsers(inboundId, [
      { name: "user1", uuid: "11111111-2222-3333-4444-555555555555" },
    ]);
    await inbounds.syncProxyNodeFromInbound(inboundId);

    const nodeRow = async () => (await query(
      'SELECT "id", "address", "updatedAt" FROM "proxy_nodes" WHERE "inboundId" = ?',
      [inboundId],
    ))[0];

    const created = await nodeRow();
    assert.equal(String(created.address), "203.0.113.10", "派生时应当抄下主机当时的入口地址");

    /** 管理员给这台机器填了自定义入口域名。 */
    await exec('UPDATE "hosts" SET "entryIp" = ? WHERE "id" = 10', ["relay.example.com"]);
    const changed = await inbounds.syncProxyNodesForHostAddress(10);
    assert.deepEqual(changed, [inboundId], "地址变了应当重新派生这个入站");
    assert.equal(
      String((await nodeRow()).address),
      "relay.example.com",
      "订阅里那条节点仍然指着旧地址：客户端连不上，而转发和隧道都显示正常",
    );

    /** 再调一次：地址没变，不该有任何动作。 */
    const before = await nodeRow();
    await exec('UPDATE "proxy_nodes" SET "updatedAt" = 0 WHERE "id" = ?', [before.id]);
    const again = await inbounds.syncProxyNodesForHostAddress(10);
    assert.deepEqual(again, [], "地址没变时不应重新派生");
    assert.equal(
      Number((await nodeRow()).updatedAt),
      0,
      "地址没变却重写了这一行：每一条地址路径都会调它，不能每次都整机重派生",
    );

    /** 主机地址算空时保持原样，而不是把订阅里的节点停掉。 */
    await exec('UPDATE "hosts" SET "entryIp" = NULL, "ip" = ?, "ipv4" = NULL WHERE "id" = 10', [""]);
    assert.deepEqual(await inbounds.syncProxyNodesForHostAddress(10), [], "主机没地址时不该动派生节点");
    assert.equal(
      String((await nodeRow()).address),
      "relay.example.com",
      "主机暂时没地址不等于这个入站不该出现在订阅里",
    );

    console.log("OK");
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /OK/);
});
