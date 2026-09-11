import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 节点 → 绑定它的转发规则。
 *
 * 这张映射是节点行上「流量」和「在线状态」两个数字的共同来源：流量按这些规则汇总，
 * 在线状态按这些规则的探测结果判定。漏一条规则就少算一份流量，多一条别人的规则
 * 就把别的节点的状态显示到这个节点上。
 */
test("按节点归拢转发规则，排除待删除的，未绑定的给空数组", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-node-rules-"));
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

      await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (1, 'alice', 'hash', 'user', 1)");
      await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (1, '广州', '1.2.3.4', '1.2.3.4', 1)");
      await exec("INSERT INTO proxy_nodes (id, userId, name, protocol, address, port, isEnabled) VALUES (1, 1, 'HKT', 'vless', 'hkt.example.com', 443, 1)");
      await exec("INSERT INTO proxy_nodes (id, userId, name, protocol, address, port, isEnabled) VALUES (2, 1, 'SG', 'vless', 'sg.example.com', 443, 1)");
      // 3 号谁都没绑，界面上显示「无转发绑定」，状态只能是未知。
      await exec("INSERT INTO proxy_nodes (id, userId, name, protocol, address, port, isEnabled) VALUES (3, 1, '没人用', 'vless', 'idle.example.com', 443, 1)");

      const insertRule = (id, port, nodeId, pendingDelete) => exec(
        "INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, isEnabled, isRunning, pendingDelete, proxyNodeId) VALUES (?, 1, ?, 'realm', 'tcp', ?, 'x', 443, 1, 1, 1, ?, ?)",
        [id, "转发" + id, port, pendingDelete, nodeId],
      );
      await insertRule(1, 20001, 1, 0);
      await insertRule(2, 20002, 1, 0);
      await insertRule(3, 20003, 2, 0);
      // 待删除的规则不该再算进来：它的流量和探测已经不代表当前状态了。
      await insertRule(4, 20004, 1, 1);
      // 没绑节点的规则跟节点无关。
      await exec("INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, isEnabled, isRunning, pendingDelete) VALUES (5, 1, '裸转发', 'realm', 'tcp', 20005, 'x', 443, 1, 1, 1, 0)");

      const map = await repo.getRuleIdsUsingProxyNodes([1, 2, 3]);
      assert.deepEqual((map.get(1) || []).sort(), [1, 2]);
      assert.deepEqual(map.get(2), [3]);
      // 未绑定的节点要给一个空数组，不能是 undefined —— 调用方直接拿它去遍历。
      assert.deepEqual(map.get(3), []);

      // 没问的节点不该凭空出现。
      assert.equal(map.has(99), false);

      // 空列表不查库，也要给一个空 Map 而不是抛错。
      assert.equal((await repo.getRuleIdsUsingProxyNodes([])).size, 0);

      // 非法 id 直接滤掉，不会拼出一条 IN (0) 之类的查询。
      assert.equal((await repo.getRuleIdsUsingProxyNodes([0, -1, NaN])).size, 0);

      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "nodes.db") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
