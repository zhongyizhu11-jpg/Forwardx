import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  持有用户计费锁去恢复规则 → 同步转发组 → 同步里对待删子规则结算流量又要同一把锁。
  锁不可重入时这里会永远卡住：这个用户的计费、开关请求全部挂起，自愈扫描也不再运行。
*/
test("restoring rules while holding the billing lock never deadlocks on group sync", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-billing-lock-"));
  const databasePath = path.join(directory, "billing-lock.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const trafficBilling = await import(moduleUrl("server/repositories/trafficBillingRepository.ts"));
    const block = await import(moduleUrl("server/trafficBillingRuleBlock.ts"));
    const billing = await import(moduleUrl("server/repositories/billingRepository.ts"));
    const { healAutoStoppedRules } = await import(moduleUrl("server/forwardRuleAutoRecovery.ts"));
    const locks = await import(moduleUrl("server/keyedTaskLock.ts"));
    const q = (name) => '"' + name + '"';
    const insert = (table, columns, values) => runtime.executeRaw(
      "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
      values,
    );
    const rule = async (id) => (await runtime.queryRaw('SELECT "isEnabled", "protocolBlockReason" FROM "forward_rules" WHERE "id" = ?', [id]))[0];
    const withinSeconds = (label, promise, seconds = 5) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("DEADLOCK: " + label + " did not finish in " + seconds + "s")), seconds * 1000)),
    ]);
    const setupBlockedTemplate = async () => {
      await runtime.executeRaw('UPDATE "forward_rules" SET "isEnabled" = 0, "protocolBlockReason" = ? WHERE "id" = 100', [block.TRAFFIC_BILLING_BALANCE_BLOCK_REASON]);
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await trafficBilling.setTrafficBillingEnabled(true);
      const userColumns = ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "allowForwardXTunnel", "accountEnabled", "balanceCents"];
      await insert("users", userColumns, [1, "admin", "x", "admin", 1, 1, 1, 1, 0]);
      await insert("users", userColumns, [2, "member", "x", "user", 1, 1, 1, 1, 500]);
      await insert("hosts", ["id", "name", "ip", "userId", "portRangeStart", "portRangeEnd"], [3, "billed", "198.51.100.3", 1, 10000, 30000]);
      await insert("traffic_billing_configs", ["id", "resourceType", "resourceId", "enabled", "requiresPermission", "pricePerGbCents", "multiplier"], [30, "forward_group", 7, 1, 0, 1, 100]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "targetIp", "isEnabled", "userId"], [7, "g", "host", "failover", "203.0.113.9", 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "isEnabled"], [70, 7, "host", 3, 1]);
      const columns = ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "forwardGroupId", "isForwardGroupTemplate", "forwardGroupRuleId", "forwardGroupMemberId", "pendingDelete", "protocolBlockReason"];
      // 因余额停下的模板规则。
      await insert("forward_rules", columns, [100, 3, "template", "iptables", "tcp", 11000, "203.0.113.1", 80, 2, 0, 0, 7, 1, null, null, 0, block.TRAFFIC_BILLING_BALANCE_BLOCK_REASON]);
      // 同一个人之前删掉的另一条模板留下的子规则，还在等 Agent 确认删除。
      await insert("forward_rules", columns, [201, 3, "old-child", "iptables", "tcp", 11001, "203.0.113.2", 80, 2, 0, 1, 7, 0, 999, 70, 1, null]);

      // 1) 外层用可重入的计费锁。
      await withinSeconds("resume under withTrafficBillingUserLock",
        locks.withTrafficBillingUserLock(2, () => block.resumeTrafficBillingRulesForUser(2)));
      assert.equal(Number((await rule(100)).isEnabled), 1);

      // 2) 自愈扫描。
      await setupBlockedTemplate();
      await withinSeconds("scheduled heal", healAutoStoppedRules("test"));
      assert.equal(Number((await rule(100)).isEnabled), 1);

      // 3) 充值后的访问恢复。
      await setupBlockedTemplate();
      await withinSeconds("access recovery after top-up", billing.recoverUserForwardAccessIfEligible(2));
      assert.equal(Number((await rule(100)).isEnabled), 1);

      // 4) 排在计费锁后面的恢复任务（scheduleUserForwardRulesAfterAccessRecovery 的排队分支）。
      await runtime.executeRaw('UPDATE "forward_rules" SET "isEnabled" = 0, "disabledByUser" = 1 WHERE "id" = 100');
      const recovery = await import(moduleUrl("server/repositories/userForwardAccessRecovery.ts"));
      await locks.withKeyedTaskLock(locks.trafficBillingUserLockKey(2), async () => {
        await runtime.withDatabaseTransaction(async () => {
          await recovery.scheduleUserForwardRulesAfterAccessRecovery(2);
        });
      });
      await withinSeconds("queued access restore", locks.withTrafficBillingUserLock(2, async () => undefined));
      assert.equal(Number((await rule(100)).isEnabled), 1);
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
    process.exit(0);
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
