import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 建转发时自动认出「这条通往我自己的落地节点」，直接进订阅。
 *
 * 订阅和转发是同一件事的两面：一条转发把入口机的端口接到落地机上，订阅里那条中转
 * 描述的就是这件事。原来要分两处做 —— 转发页建规则，再去订阅页的预览弹窗里绑。
 * 不绑就不进订阅，而转发页上完全看不出少了这一步。
 *
 * 这一组盯的是「宁可不认」：认错的后果是订阅里那条中转指向了一台不该指的落地机。
 */
function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-autobind-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      const subs = await import(url("server/repositories/proxySubscriptionRepository.ts"));
      const { matchProxyNodeForTarget } = await import(url("shared/proxyNodeAutoBind.ts"));

      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      const query = (sql, params = []) => runtime.queryRaw(sql, params);

      await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (1, 'alice', 'hash', 'admin', 1)");
      await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (2, 'bob', 'hash', 'user', 1)");
      await exec("INSERT INTO hosts (id, name, ip, ipv4, agentToken, userId) VALUES (10, '入口', '9.9.9.9', '9.9.9.9', 'tok', 1)");

      const makeNode = async (userId, name, address, port, isEnabled = true) => Number(await subs.createProxyNode({
        userId, name, protocol: "vless", address, port,
        uuid: "11111111-2222-3333-4444-555555555555", transport: "tcp", tls: true,
        isEnabled, includeDirect: false,
      }));

      /** 走和服务端同一套判断：候选集就是「我订阅里能用的那些节点」。 */
      const autoBindFor = async (userId, targetIp, targetPort) => {
        const candidates = (await subs.getProxyNodesForSubscription(userId)).map((node) => ({
          id: Number(node.id),
          address: String(node.address || ""),
          port: Number(node.port || 0),
          isEnabled: node.isEnabled !== false,
          sharedFrom: !!node.sharedFrom,
        }));
        return matchProxyNodeForTarget(candidates, targetIp, targetPort);
      };

      ${body}

      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "autobind.db") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("目标正好是自己的落地节点：认得出来", () => {
  runInDatabase(String.raw`
    const nodeId = await makeNode(1, "HK 落地", "hk.example.com", 443);
    assert.equal((await autoBindFor(1, "hk.example.com", 443))?.id, nodeId);
  `);
});

test("别人的节点不会被认成我的", () => {
  runInDatabase(String.raw`
    await makeNode(2, "bob 的落地", "hk.example.com", 443);
    // 同样的地址端口，但那是 bob 的节点 —— 认了就等于把别人的线路塞进我的订阅。
    assert.equal(await autoBindFor(1, "hk.example.com", 443), null);
  `);
});

test("分享给我的节点算数", () => {
  runInDatabase(String.raw`
    const nodeId = await makeNode(1, "HK 落地", "hk.example.com", 443);
    await subs.setProxyNodeSharesForUser(2, [nodeId], { label: "bob" });
    // 分享来的也是「我能用的线路」，认它是对的。
    assert.equal((await autoBindFor(2, "hk.example.com", 443))?.id, nodeId);
  `);
});

test("停用的节点不认", () => {
  runInDatabase(String.raw`
    await makeNode(1, "停用的", "hk.example.com", 443, false);
    assert.equal(await autoBindFor(1, "hk.example.com", 443), null);
  `);
});

test("两个节点同地址同端口：一个都不认", () => {
  runInDatabase(String.raw`
    await makeNode(1, "A", "hk.example.com", 443);
    await makeNode(1, "B", "hk.example.com", 443);
    // 猜错一次就是订阅里指向了错的落地机，不如让人自己选。
    assert.equal(await autoBindFor(1, "hk.example.com", 443), null);
  `);
});

test("端口不同不认，地址像也不认", () => {
  runInDatabase(String.raw`
    await makeNode(1, "HK 落地", "hk.example.com", 443);
    assert.equal(await autoBindFor(1, "hk.example.com", 8443), null);
    assert.equal(await autoBindFor(1, "hk.example.com.cn", 443), null);
  `);
});
