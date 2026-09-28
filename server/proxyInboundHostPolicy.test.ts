import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 普通用户在别人机器上开落地节点：
 *   - 端口要守那台机器的端口策略，也不能和转发规则 / 隧道撞
 *   - 不能指定证书文件路径（只能 ACME / REALITY）
 *   - 授权收回后运行时不再下发、也改不了
 * 管理员替租户开的（分租）不靠主机授权，不受收回影响；自己的机器不受这些限制。
 */
test("proxy inbounds on granted hosts follow host port policy, cert rules and grant revocation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-proxy-inbound-policy-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const inbounds = await import(moduleUrl("server/repositories/proxyInboundRepository.ts"));
    const { proxyInboundsRouter } = await import(moduleUrl("server/routers/proxyInbounds.ts"));
    const q = (name) => '"' + name + '"';
    const insert = (table, columns, values) => runtime.executeRaw(
      "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
      values,
    );
    const context = (user) => ({ req: { headers: {} }, res: { clearCookie() {} }, user, authSession: null, authFailureReason: null });
    const runtimeIds = async (hostId) => (await inbounds.getEnabledProxyInboundsWithUsersByHost(hostId)).map((row) => Number(row.id)).sort((a, b) => a - b);
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "accountEnabled", "allowProxySubscription"], [1, "admin", "x", "admin", 1, 1, 1]);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "accountEnabled", "allowProxySubscription"], [2, "member", "x", "user", 1, 1, 1]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "portRangeStart", "portRangeEnd"], [1, "shared", "198.18.4.1", "198.18.4.1", 1, 1, now, 20000, 20100]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "portRangeStart", "portRangeEnd"], [5, "own", "198.18.4.5", "198.18.4.5", 2, 1, now, 20000, 20100]);
      await insert("user_host_permissions", ["userId", "hostId"], [2, 1]);
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled"],
        [100, 1, "admin-forward", "gost", "tcp", 20010, "203.0.113.10", 80, 1, 1],
      );

      const member = proxyInboundsRouter.createCaller(context({ id: 2, username: "member", role: "user", accountEnabled: true }));
      const admin = proxyInboundsRouter.createCaller(context({ id: 1, username: "admin", role: "admin", accountEnabled: true }));
      const base = { name: "node", protocol: "vless", security: "reality" };

      await assert.rejects(() => member.create({ ...base, hostId: 1, port: 443 }), /落地节点端口/, "the host port policy applies on a granted host");
      await assert.rejects(() => member.create({ ...base, hostId: 1, port: 20010 }), /转发规则或隧道占用/);
      await assert.rejects(
        () => member.create({ ...base, hostId: 1, port: 20020, security: "tls", certPath: "/etc/ssl/other.pem", keyPath: "/etc/ssl/other.key" }),
        /证书文件路径/,
      );
      const granted = await member.create({ ...base, hostId: 1, port: 20020 });
      const own = await member.create({ ...base, hostId: 5, port: 443, security: "tls", certPath: "/etc/ssl/me.pem", keyPath: "/etc/ssl/me.key" });
      const rented = await admin.create({ ...base, hostId: 1, port: 20030, userId: 2 });
      const flags = await runtime.queryRaw('SELECT "id", "hostGrantRequired" FROM "proxy_inbounds" ORDER BY "id"');
      assert.deepEqual(flags.map((row) => [Number(row.id), Number(row.hostGrantRequired)]), [
        [Number(granted.id), 1],
        [Number(own.id), 0],
        [Number(rented.id), 0],
      ]);
      await assert.rejects(() => member.update({ id: Number(granted.id), port: 20010 }), /转发规则或隧道占用/);
      await member.update({ id: Number(granted.id), port: 20021 });

      assert.deepEqual(await runtimeIds(1), [Number(granted.id), Number(rented.id)].sort((a, b) => a - b));
      await runtime.executeRaw('DELETE FROM "user_host_permissions" WHERE "userId" = 2');
      assert.deepEqual(await runtimeIds(1), [Number(rented.id)], "a self-built inbound stops once its host grant is revoked; an admin-assigned one stays");
      assert.deepEqual(await runtimeIds(5), [Number(own.id)]);
      await assert.rejects(() => member.update({ id: Number(granted.id), name: "renamed" }), /无权在该主机上开落地节点/);
      await member.update({ id: Number(rented.id), name: "renamed-rental" });
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;
  try {
    const scriptPath = path.join(directory, "proxy-inbound.mjs");
    fs.writeFileSync(scriptPath, script, "utf8");
    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "t.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
