import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  「检查端口」要和保存走同一道闸：租户在共享主机/共享转发组入口上查 22、80 或面板端口，
  原来会显示「可用」，点保存才报错。
*/
test("checkPort rejects system and panel ports for tenants on shared hosts and forward groups", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-check-port-tenant-"));
  const databasePath = path.join(directory, "check-port-tenant.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const callerContext = (user) => ({
      req: { headers: {} },
      res: { clearCookie() {} },
      user,
      authSession: null,
      authFailureReason: null,
    });

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role", "canAddRules"], [1, "admin", "x", "admin", 1]);
      await insert("users", ["id", "username", "password", "role", "canAddRules"], [2, "tenant", "x", "user", 1]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"], [1, "shared", "198.51.100.10", "198.51.100.10", 1, 1, now]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"], [2, "own", "198.51.100.11", "198.51.100.11", 2, 1, now]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "domain", "targetIp", "userId", "isEnabled"], [10, "shared-group", "host", "port", "", "0.0.0.0", 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 0, 1]);
      await insert("subscription_plans", ["id", "name"], [50, "shared"]);
      await insert("subscription_plan_hosts", ["planId", "hostId"], [50, 1]);
      await insert("subscription_plan_forward_groups", ["planId", "forwardGroupId"], [50, 10]);
      await insert("user_subscriptions", ["id", "userId", "planId", "status"], [60, 2, 50, "active"]);

      const tenant = rulesRouter.createCaller(callerContext({ id: 2, username: "tenant", role: "user", accountEnabled: true }));
      const admin = rulesRouter.createCaller(callerContext({ id: 1, username: "admin", role: "admin", accountEnabled: true }));

      const ssh = await tenant.checkPort({ hostId: 1, sourcePort: 22, protocol: "tcp" });
      assert.equal(ssh.used, true);
      assert.match(ssh.reason, /系统保留端口/);
      const panel = await tenant.checkPort({ hostId: 1, sourcePort: 17555, protocol: "tcp" });
      assert.equal(panel.used, true);
      assert.match(panel.reason, /面板自身使用的端口/);
      assert.deepEqual(await tenant.checkPort({ hostId: 1, sourcePort: 20000, protocol: "tcp" }), { used: false });

      const groupSsh = await tenant.checkPort({ forwardGroupId: 10, sourcePort: 22, protocol: "tcp" });
      assert.equal(groupSsh.used, true);
      assert.match(groupSsh.reason, /系统保留端口/);
      assert.deepEqual(await tenant.checkPort({ forwardGroupId: 10, sourcePort: 20000, protocol: "tcp" }), { used: false });

      // 自己的主机、管理员不受限制
      assert.deepEqual(await tenant.checkPort({ hostId: 2, sourcePort: 22, protocol: "tcp" }), { used: false });
      assert.deepEqual(await admin.checkPort({ hostId: 1, sourcePort: 22, protocol: "tcp" }), { used: false });
      assert.deepEqual(await admin.checkPort({ forwardGroupId: 10, sourcePort: 22, protocol: "tcp" }), { used: false });
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, PORT: "17555" },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
