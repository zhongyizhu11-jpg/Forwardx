import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 转发组的子规则跟着模板开线路组：以前子规则只在 TCP + gost 时才开（和规则本身的限制一致），
 * 规则那边放开到 UDP、TCP+UDP 和 realm / socat / nginx 之后，这里得跟着放开 —— 不然模板存得下、
 * 子规则却悄悄不切换。内核转发（iptables / nftables）照旧不开：调度器插不进去。
 */
test("转发组子规则：UDP、TCP+UDP、realm / socat 跟着模板开线路组，内核转发不开", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-route-"));
  const databasePath = path.join(directory, "group-route.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role"], [1, "admin", "hash", "admin"]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"], [1, "host-1", "198.51.100.10", "198.51.100.10", 1, 1, now]);
      await insert("forward_groups", [
        "id", "name", "groupType", "groupMode", "forwardType", "failoverRuntimeInheritanceEnabled", "targetIp", "userId", "isEnabled",
      ], [10, "group", "host", "failover", "gost", 0, "0.0.0.0", 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 0, 1]);
      const backup = JSON.stringify([{ targetIp: "198.51.100.9", targetPort: 80 }]);
      const templates = [
        [100, "realm", "udp", 16000],
        [110, "iptables", "tcp", 16010],
        [120, "socat", "both", 16020],
        [130, "gost", "tcp", 16030],
      ];
      for (const [id, forwardType, protocol, sourcePort] of templates) {
        await insert("forward_rules", [
          "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate",
          "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "failoverEnabled", "failoverTargets",
        ], [id, 1, "template-" + id, forwardType, protocol, 10, 1, sourcePort, "203.0.113.10", 80, 1, 1, 0, 1, backup]);
      }

      const forwardGroups = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
      await forwardGroups.syncForwardGroupRules(10);
      const children = await runtime.queryRaw(
        'SELECT "forwardGroupRuleId", "forwardType", "protocol", "failoverEnabled", "failoverTargets" FROM "forward_rules"'
          + ' WHERE "forwardGroupId" = ? AND "isForwardGroupTemplate" = 0 ORDER BY "forwardGroupRuleId"',
        [10],
      );
      const byTemplate = Object.fromEntries(children.map((row) => [Number(row.forwardGroupRuleId), row]));
      for (const id of [100, 120, 130]) {
        assert.ok(byTemplate[id], "模板 " + id + " 没有生成子规则");
        assert.equal(Number(byTemplate[id].failoverEnabled), 1, "模板 " + id + "（" + byTemplate[id].forwardType + " " + byTemplate[id].protocol + "）的子规则应当开着线路组");
        assert.equal(byTemplate[id].failoverTargets, backup);
      }
      assert.ok(byTemplate[110], "iptables 模板没有生成子规则");
      assert.equal(Number(byTemplate[110].failoverEnabled), 0, "内核转发的子规则开不了线路组");
      assert.equal(byTemplate[110].failoverTargets, null);
      console.log("GROUP-ROUTE-OK");
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FORWARDX_LOG_DIR: path.join(directory, "logs") },
    encoding: "utf8",
    timeout: 120_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /GROUP-ROUTE-OK/);
});
