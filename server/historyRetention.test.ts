import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 每小时历史清理新加的两项保留策略，以及几处「调用方已经读过/锁过就别再来一遍」的省查询。
 *
 * 保留策略删的是永远不会再被读的行，所以这里钉的是**删对**：
 *   - auth_sessions：只删过期或撤销超过 7 天的；还在用的、刚过期的、刚撤销的都留着。
 *   - config_audit_events：只删 30 天前的 dispatch 行；配置改动（create/update/delete）
 *     一条不动 —— 它们决定下发版本号和 Mimic 生命周期签名。
 *
 * 省查询那几处钉的是**省了而且结果没变**：
 *   - touchAuthSession 带上已读的会话行只剩一条 UPDATE，而那条 UPDATE 仍带「未撤销」条件，
 *     中途被撤销的会话不会被写回来。
 *   - billTrafficUsage 带上同一事务里已拿到的开关/配置/锁，扣费结果与不带时完全一致。
 */

type Probe = {
  sessionsLeft: string[];
  sessionsDeleted: number;
  auditLeft: string[];
  auditDeleted: number;
  touch: { withLoaded: number; withoutLoaded: number; throttled: number; revokedLastSeenUnchanged: boolean };
  billing: { plain: any; precomputed: any; plainCost: number; precomputedCost: number; balances: number[] };
};

function runProbe(): Probe {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-history-retention-"));
  const databasePath = path.join(directory, "retention.db");
  const script = String.raw`
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const Database = (await import("better-sqlite3")).default;
    const originalPrepare = Database.prototype.prepare;
    let recording = false;
    let statements = [];
    Database.prototype.prepare = function (sql) {
      if (recording) statements.push(String(sql));
      return originalPrepare.call(this, sql);
    };
    const measure = async (fn) => {
      statements = []; recording = true;
      try { const value = await fn(); return { value, count: statements.length }; } finally { recording = false; }
    };

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const sessions = await import(url("server/repositories/sessionRepository.ts"));
    const audit = await import(url("server/configAudit.ts"));
    const billing = await import(url("server/repositories/trafficBillingRepository.ts"));

    const now = Math.floor(Date.now() / 1000);
    const day = 24 * 3600;
    await exec("INSERT INTO users (id, username, password, role, \"balanceCents\") VALUES (1, 'admin', 'h', 'admin', 0), (7, 'u7', 'h', 'user', 1000), (8, 'u8', 'h', 'user', 1000)");

    // ---- auth_sessions ----
    const sessionRows = [
      ["active", now + day, null],
      ["expired-1d", now - day, null],
      ["expired-8d", now - 8 * day, null],
      ["revoked-2d", now + day, now - 2 * day],
      ["revoked-8d", now + day, now - 8 * day],
      ["revoked-8d-expired-9d", now - 9 * day, now - 8 * day],
    ];
    for (const [sid, expiresAt, revokedAt] of sessionRows) {
      await exec('INSERT INTO auth_sessions (sid, "userId", kind, "expiresAt", "revokedAt", "createdAt", "lastSeenAt") VALUES (?, 1, ?, ?, ?, ?, ?)', [sid, "browser", expiresAt, revokedAt, now - 10 * day, now - 10 * day]);
    }
    const sessionsDeleted = await sessions.pruneStaleAuthSessions(7);
    const sessionsLeft = (await runtime.queryRaw('SELECT sid FROM auth_sessions ORDER BY sid')).map((row) => row.sid);

    // ---- config_audit_events ----
    const auditRows = [
      ["dispatch-31d", "dispatch", "runtime", now - 31 * day],
      ["dispatch-29d", "dispatch", "runtime", now - 29 * day],
      ["update-60d", "update", "forward_rule", now - 60 * day],
      ["create-60d", "create", "tunnel", now - 60 * day],
      ["delete-60d", "delete", "host", now - 60 * day],
    ];
    for (const [hash, action, resourceType, createdAt] of auditRows) {
      await exec('INSERT INTO config_audit_events ("resourceType", "resourceId", action, source, "configHash", "createdAt") VALUES (?, 1, ?, ?, ?, ?)', [resourceType, action, "test", hash, createdAt]);
    }
    const auditDeleted = await audit.pruneDispatchConfigAuditEvents(30);
    const auditLeft = (await runtime.queryRaw('SELECT "configHash" FROM config_audit_events ORDER BY "configHash"')).map((row) => row.configHash);

    // ---- touchAuthSession ----
    const expiresAt = new Date((now + day) * 1000);
    await sessions.createAuthSession({ userId: 1, sid: "touch-a", kind: "browser", expiresAt });
    await sessions.createAuthSession({ userId: 1, sid: "touch-b", kind: "browser", expiresAt });
    await exec('UPDATE auth_sessions SET "lastSeenAt" = ? WHERE sid IN (?, ?)', [now - day, "touch-a", "touch-b"]);
    const loadedA = await sessions.getActiveAuthSession(1, "touch-a", "browser");
    const withLoaded = (await measure(() => sessions.touchAuthSession(1, "touch-a", "browser", loadedA))).count;
    const withoutLoaded = (await measure(() => sessions.touchAuthSession(1, "touch-b", "browser"))).count;
    const reloadedA = await sessions.getActiveAuthSession(1, "touch-a", "browser");
    const throttled = (await measure(() => sessions.touchAuthSession(1, "touch-a", "browser", reloadedA))).count;
    // 读完之后、写之前被撤销：拿着旧行去 touch，守卫条件要让撤销赢
    await sessions.createAuthSession({ userId: 1, sid: "touch-c", kind: "browser", expiresAt });
    await exec('UPDATE auth_sessions SET "lastSeenAt" = ? WHERE sid = ?', [now - day, "touch-c"]);
    const loadedC = await sessions.getActiveAuthSession(1, "touch-c", "browser");
    await sessions.revokeAuthSession(1, "touch-c", "browser", "logout");
    await sessions.touchAuthSession(1, "touch-c", "browser", loadedC);
    const [rowC] = await runtime.queryRaw('SELECT "lastSeenAt", "revokedAt" FROM auth_sessions WHERE sid = ?', ["touch-c"]);
    const revokedLastSeenUnchanged = Number(rowC.lastSeenAt) === now - day && !!rowC.revokedAt;

    // ---- billTrafficUsage：带不带 precomputed 结果一致 ----
    await exec('INSERT INTO hosts (id, name, ip, "hostType", "agentToken", "userId") VALUES (5, ?, ?, ?, ?, 1), (6, ?, ?, ?, ?, 1)', ["h5", "10.0.0.5", "slave", "t5", "h6", "10.0.0.6", "slave", "t6"]);
    await exec('INSERT INTO forward_rules (id, "hostId", name, "sourcePort", "targetIp", "targetPort", "userId") VALUES (12, 5, ?, 12012, ?, 80, 7), (13, 6, ?, 12013, ?, 80, 8)', ["r12", "127.0.0.1", "r13", "127.0.0.1"]);
    await exec('INSERT INTO traffic_billing_configs ("resourceType", "resourceId", enabled, "requiresPermission", "pricePerGbCents", multiplier) VALUES (?, 5, 1, 0, 100, 150), (?, 6, 1, 0, 100, 150)', ["host", "host"]);
    await billing.setTrafficBillingEnabled(true);
    const GB = 1024 * 1024 * 1024;
    const plain = [];
    let plainCost = 0;
    for (const bytes of [Math.floor(1.5 * GB), GB, 10]) {
      const result = await measure(() => billing.billTrafficUsage({ userId: 7, ruleId: 12, bytes, resourceType: "host", resourceId: 5 }));
      plain.push(result.value);
      plainCost += result.count;
    }
    const precomputed = [];
    let precomputedCost = 0;
    for (const bytes of [Math.floor(1.5 * GB), GB, 10]) {
      await runtime.withDatabaseTransaction(async () => {
        const rule = (await runtime.queryRaw("SELECT * FROM forward_rules WHERE id = 13"))[0];
        const enabled = await billing.getTrafficBillingEnabledForWrite();
        const resource = (await billing.findTrafficBillingResourcesForRules([rule])).get(13);
        await billing.lockTrafficBillingUserRows([8]);
        const result = await measure(() => billing.billTrafficUsage(
          { userId: 8, ruleId: 13, bytes, resourceType: "host", resourceId: 6 },
          { config: resource.config, billingEnabled: enabled, alreadyLocked: true },
        ));
        precomputed.push(result.value);
        precomputedCost += result.count;
      });
    }
    const balances = (await runtime.queryRaw('SELECT "balanceCents" FROM users WHERE id IN (7, 8) ORDER BY id')).map((row) => Number(row.balanceCents));

    console.log("RETENTION " + JSON.stringify({
      sessionsLeft, sessionsDeleted, auditLeft, auditDeleted,
      touch: { withLoaded, withoutLoaded, throttled, revokedLastSeenUnchanged },
      billing: { plain, precomputed, plainCost, precomputedCost, balances },
    }));
    await runtime.closeDatabase();
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    timeout: 120000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("RETENTION "));
  assert.ok(line, `没拿到探测结果：\n${result.stdout}`);
  return JSON.parse(line.slice("RETENTION ".length)) as Probe;
}

const probe = runProbe();

test("会话保留：只删过期或撤销超过 7 天的行", () => {
  assert.deepEqual(probe.sessionsLeft, ["active", "expired-1d", "revoked-2d"]);
  assert.equal(probe.sessionsDeleted, 3);
});

test("审计保留：只删 30 天前的 dispatch，配置改动一条不动", () => {
  assert.deepEqual(probe.auditLeft, ["create-60d", "delete-60d", "dispatch-29d", "update-60d"]);
  assert.equal(probe.auditDeleted, 1);
});

test("touchAuthSession 带上已读的会话行就不再读一遍，撤销仍然赢", () => {
  assert.equal(probe.touch.withoutLoaded, 2, "不带已读行：先读再写，两条");
  assert.equal(probe.touch.withLoaded, 1, "带上已读行：只剩那条带守卫的 UPDATE");
  assert.equal(probe.touch.throttled, 0, "刚 touch 过：节流窗口内一条都不该打");
  assert.ok(probe.touch.revokedLastSeenUnchanged, "拿着撤销前读到的行去 touch，不能把已撤销会话的 lastSeenAt 写回来");
});

test("billTrafficUsage 带上同一事务里已有的开关/配置/锁，结果不变、查询变少", () => {
  assert.deepEqual(probe.billing.precomputed, probe.billing.plain);
  assert.equal(probe.billing.balances[0], probe.billing.balances[1]);
  assert.ok(probe.billing.balances[0] < 1000, "测试数据要真的跨过整 GB 扣到费，不然等于没测");
  assert.ok(
    probe.billing.precomputedCost < probe.billing.plainCost,
    `带 precomputed 反而没省：${probe.billing.precomputedCost} vs ${probe.billing.plainCost}`,
  );
});
