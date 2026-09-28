import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("rules stopped by the system resume once their cause clears; manually stopped rules stay off", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-auto-recovery-"));
  const databasePath = path.join(directory, "auto-recovery.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const tunnels = await import(moduleUrl("server/repositories/tunnelRepository.ts"));
    const { healAutoStoppedRules } = await import(moduleUrl("server/forwardRuleAutoRecovery.ts"));
    const { RULE_RESOURCE_AUTHORIZATION_REVOKED_REASON } = await import(moduleUrl("server/ruleResourceAuthorization.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => runtime.executeRaw(
      "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
      values,
    );
    const rule = async (id) => (await runtime.queryRaw(
      'SELECT "isEnabled", "disabledByUser", "disabledByTunnel", "disabledByGroup", "protocolBlockReason" FROM "forward_rules" WHERE "id" = ?',
      [id],
    ))[0];
    const bool = (value) => value === true || value === 1 || value === "1";

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await insert("users", ["id", "username", "password", "role", "canAddRules", "allowForwardXTunnel", "accountEnabled"], [2, "active", "x", "user", 1, 1, 1]);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "allowForwardXTunnel", "accountEnabled", "forwardAccessPauseReason"], [3, "expired", "x", "user", 0, 0, 1, "expired"]);
      for (const [id, name, ip] of [[1, "entry", "198.51.100.1"], [4, "exit", "198.51.100.4"]]) {
        await insert("hosts", ["id", "name", "ip", "userId", "portRangeStart", "portRangeEnd"], [id, name, ip, 2, 10000, 20000]);
      }
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"], [30, "back-on-tunnel", 1, 4, "tls", 19000, 2, 1]);
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"], [31, "still-off-tunnel", 1, 4, "tls", 19001, 2, 0]);

      const columns = ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "disabledByUser", "disabledByTunnel", "protocolBlockReason"];
      // 隧道已经开回来了，规则却还标着「因隧道停用而停」（恢复那一步没走完）。
      await insert("forward_rules", columns, [200, 1, "stuck-by-tunnel", "gost", "tcp", 30, 11000, "203.0.113.1", 80, 2, 0, 0, 1, null]);
      // 隧道还关着：不能恢复。
      await insert("forward_rules", columns, [201, 1, "tunnel-still-off", "gost", "tcp", 31, 11001, "203.0.113.2", 80, 2, 0, 0, 1, null]);
      // 手动关掉的：谁也不许替用户打开。
      await insert("forward_rules", columns, [202, 1, "manually-off", "gost", "tcp", 30, 11002, "203.0.113.3", 80, 2, 0, 0, 0, null]);
      // 主人已到期：隧道恢复不能把他的规则带起来，改记成账户暂停。
      await insert("forward_rules", columns, [203, 1, "owner-expired", "gost", "tcp", 30, 11003, "203.0.113.4", 80, 3, 0, 0, 1, null]);
      // 账户已恢复、规则还标着账户暂停。
      await insert("forward_rules", columns, [204, 1, "stuck-by-user-pause", "iptables", "tcp", null, 11004, "203.0.113.5", 80, 2, 0, 1, 0, null]);
      // 授权失效过、现在又有权限了（主机是他自己的）。
      await insert("forward_rules", columns, [205, 1, "reauthorized", "iptables", "tcp", null, 11005, "203.0.113.6", 80, 2, 0, 0, 0, RULE_RESOURCE_AUTHORIZATION_REVOKED_REASON]);
      // 别的原因（端口冲突）停的：不是授权失效，不动。
      await insert("forward_rules", columns, [206, 1, "port-conflict", "iptables", "tcp", null, 11006, "203.0.113.7", 80, 2, 0, 0, 0, "端口冲突"]);

      const result = await healAutoStoppedRules("test");
      assert.equal(bool((await rule(200)).isEnabled), true, "a rule stopped by a tunnel that is back on must resume");
      assert.equal(bool((await rule(200)).disabledByTunnel), false);
      assert.equal(bool((await rule(201)).isEnabled), false, "a rule on a still-disabled tunnel must stay stopped");
      assert.equal(bool((await rule(201)).disabledByTunnel), true, "the tunnel must keep ownership of the blocker");
      assert.equal(bool((await rule(202)).isEnabled), false, "a manually stopped rule must never be turned on");
      assert.equal(bool((await rule(203)).isEnabled), false, "a paused owner's rule must not start with the tunnel");
      assert.equal(bool((await rule(203)).disabledByUser), true, "the account recovery path must own a paused owner's rule");
      assert.equal(bool((await rule(204)).isEnabled), true, "a rule stuck after the account recovered must resume");
      assert.equal(bool((await rule(205)).isEnabled), true, "a rule whose authorization is back must resume");
      assert.equal((await rule(205)).protocolBlockReason, null);
      assert.equal(bool((await rule(206)).isEnabled), false, "a rule blocked for another reason must stay stopped");
      assert.equal((await rule(206)).protocolBlockReason, "端口冲突");
      assert.ok(result.tunnelRules >= 1 && result.userRules >= 1 && result.authorizationRules >= 1);

      // 手动关隧道、再开：规则跟着停、跟着回来。
      await tunnels.updateTunnel(30, { isEnabled: false });
      await tunnels.disableForwardRulesByTunnel(30, "test");
      assert.equal(bool((await rule(200)).isEnabled), false);
      assert.equal(bool((await rule(200)).disabledByTunnel), true);
      await tunnels.updateTunnel(30, { isEnabled: true });
      await tunnels.restoreForwardRulesByTunnel(30);
      assert.equal(bool((await rule(200)).isEnabled), true);
      assert.equal(bool((await rule(202)).isEnabled), false, "turning a tunnel back on must not enable its manually stopped rules");

      // 到期的人续上了：之前被改记成账户暂停的规则跟着账户恢复。
      await runtime.executeRaw('UPDATE "users" SET "canAddRules" = 1, "forwardAccessPauseReason" = NULL WHERE "id" = 3');
      await healAutoStoppedRules("test-renewed");
      assert.equal(bool((await rule(203)).isEnabled), true, "a renewed owner's rules must resume without manual work");

      // 管理员余额为 0、规则走了计费资源：不能被自动暂停。
      const users = await import(moduleUrl("server/repositories/userRepository.ts"));
      await insert("users", ["id", "username", "password", "role", "canAddRules", "allowForwardXTunnel", "accountEnabled", "balanceCents"], [1, "admin", "x", "admin", 1, 1, 1, 0]);
      await insert("forward_rules", columns, [210, 1, "admin-rule", "gost", "tcp", 30, 11010, "203.0.113.10", 80, 1, 1, 0, 0, null]);
      await users.setUserForwardAccess(1, false, "traffic_billing_balance");
      await users.disableAllUserRules(1);
      assert.equal(bool((await rule(210)).isEnabled), true, "an admin's rules must never be stopped by billing or entitlement checks");
      const [adminAfterBilling] = await runtime.queryRaw('SELECT "canAddRules", "forwardAccessPauseReason" FROM "users" WHERE "id" = 1');
      assert.equal(bool(adminAfterBilling.canAddRules), true);
      assert.equal(adminAfterBilling.forwardAccessPauseReason, null);

      // 旧版本留下的管理员自动暂停：扫描撤掉暂停并把规则拉回来。
      await runtime.executeRaw('UPDATE "users" SET "canAddRules" = 0, "forwardAccessPauseReason" = ? WHERE "id" = 1', ["traffic_billing_balance"]);
      await runtime.executeRaw('UPDATE "forward_rules" SET "isEnabled" = 0, "disabledByUser" = 1 WHERE "id" = 210');
      await healAutoStoppedRules("test-admin");
      assert.equal(bool((await rule(210)).isEnabled), true, "an admin paused by an older version must get the rules back automatically");
      const [adminAfterHeal] = await runtime.queryRaw('SELECT "canAddRules", "forwardAccessPauseReason" FROM "users" WHERE "id" = 1');
      assert.equal(bool(adminAfterHeal.canAddRules), true);
      assert.equal(adminAfterHeal.forwardAccessPauseReason, null);

      // 什么都不需要恢复时，扫描是空操作。
      const idle = await healAutoStoppedRules("test-idle");
      assert.deepEqual(idle, { tunnels: 0, tunnelRules: 0, groupRules: 0, userRules: 0, authorizationRules: 0 });
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;

  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: databasePath,
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
