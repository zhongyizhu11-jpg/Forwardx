import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertTenantListenPortAllowed } from "./tenantListenPortGuard";
import { ENV } from "./env";

test("tenants cannot listen on system ports or the panel port of hosts they do not own", () => {
  const tenant = { id: 2, role: "user" };
  const adminHost = { userId: 1 };
  const ownHost = { userId: 2 };
  assert.throws(() => assertTenantListenPortAllowed({ actor: tenant, host: adminHost, port: 22 }), /系统保留端口/);
  assert.throws(() => assertTenantListenPortAllowed({ actor: tenant, host: adminHost, port: 1023 }), /系统保留端口/);
  assert.throws(() => assertTenantListenPortAllowed({ actor: tenant, host: null, port: 53 }), /系统保留端口/);
  assert.throws(() => assertTenantListenPortAllowed({ actor: tenant, host: adminHost, port: ENV.port }), /面板自身/);
  assert.doesNotThrow(() => assertTenantListenPortAllowed({ actor: tenant, host: adminHost, port: 1024 }));
  // 自己的主机、管理员都不受限；0 表示自动分配，不在这里检查。
  assert.doesNotThrow(() => assertTenantListenPortAllowed({ actor: tenant, host: ownHost, port: 22 }));
  assert.doesNotThrow(() => assertTenantListenPortAllowed({ actor: { id: 1, role: "admin" }, host: ownHost, port: 22 }));
  assert.doesNotThrow(() => assertTenantListenPortAllowed({ actor: tenant, host: adminHost, port: 0 }));
});

test("re-enabling a tenant rule on a shared host's system port is refused", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-tenant-rule-ports-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      await exec("INSERT INTO users (id, username, password, role, canAddRules) VALUES (1, 'admin', 'hash', 'admin', 1)");
      await exec("INSERT INTO users (id, username, password, role, canAddRules) VALUES (2, 'tenant', 'hash', 'user', 1)");
      await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (1, 'shared', '1.2.3.4', '1.2.3.4', 1)");
      await exec('INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled") VALUES (100, 1, ?, ?, ?, 22, ?, 22, 2, 0)', ["ssh-hijack", "iptables", "tcp", "203.0.113.9"]);
      await import(url("server/routers/rules.ts"));
      const { toggleForwardRuleForActor } = await import(url("server/routers/rules.crud.ts"));
      await assert.rejects(toggleForwardRuleForActor({ id: 2, role: "user" }, 100, true), /系统保留端口/);
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "rules.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("proxy inbounds: shared-host port guard and admin-only quota fields", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-tenant-ports-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (1, 'admin', 'hash', 'admin', 1)");
      await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (2, 'tenant', 'hash', 'user', 1)");
      await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (1, 'shared', '1.2.3.4', '1.2.3.4', 1)");
      await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (2, 'own', '5.6.7.8', '5.6.7.8', 2)");
      await exec('INSERT INTO user_host_permissions ("userId", "hostId") VALUES (2, 1)');

      const { proxyInboundsRouter } = await import(url("server/routers/proxyInbounds.ts"));
      const context = (user) => ({ req: { headers: {} }, res: { clearCookie() {} }, user, authSession: null, authFailureReason: null });
      const tenant = proxyInboundsRouter.createCaller(context({ id: 2, role: "user", username: "tenant" }));
      const admin = proxyInboundsRouter.createCaller(context({ id: 1, role: "admin", username: "admin" }));
      const ss = { protocol: "shadowsocks", method: "2022-blake3-aes-128-gcm" };
      const row = async (id) => (await runtime.queryRaw('SELECT "port", "trafficLimit", "trafficUsed", "bandwidthMbps" FROM "proxy_inbounds" WHERE "id" = ?', [id]))[0];

      await assert.rejects(tenant.create({ ...ss, hostId: 1, name: "ssh", port: 22 }), /系统保留端口/);
      // 自己的主机上可以用低端口，但额度字段一律忽略。
      const own = await tenant.create({ ...ss, hostId: 2, name: "own", port: 443, trafficLimit: 999, trafficUsed: 5, bandwidthMbps: 100 });
      const ownRow = await row(own.id);
      assert.equal(Number(ownRow.port), 443);
      assert.equal(Number(ownRow.trafficLimit || 0), 0);
      assert.equal(Number(ownRow.trafficUsed || 0), 0);
      assert.equal(Number(ownRow.bandwidthMbps || 0), 0);

      const leased = await admin.create({ ...ss, hostId: 1, userId: 2, name: "leased", port: 20000, trafficLimit: 1000, trafficUsed: 10, bandwidthMbps: 50 });
      await tenant.update({ id: leased.id, name: "renamed", trafficLimit: 0, trafficUsed: 0, bandwidthMbps: 0 });
      const leasedRow = await row(leased.id);
      assert.equal(Number(leasedRow.trafficLimit), 1000, "tenant cannot lift its own quota");
      assert.equal(Number(leasedRow.trafficUsed), 10, "tenant cannot reset its own usage");
      assert.equal(Number(leasedRow.bandwidthMbps), 50, "tenant cannot raise its own bandwidth cap");
      await assert.rejects(tenant.update({ id: leased.id, port: 80 }), /系统保留端口/);
      await admin.update({ id: leased.id, trafficLimit: 2000 });
      assert.equal(Number((await row(leased.id)).trafficLimit), 2000, "admins still manage quotas");
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "ports.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
