import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("route-group relay rules only run while their parent rule runs", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-relay-gate-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { gateForwardRulesForRuntime } = await import(moduleUrl("server/linkAccessView.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw('INSERT INTO "users" ("id", "username", "password", "role") VALUES (1, \'admin\', \'x\', \'admin\')');
      await runtime.executeRaw('INSERT INTO "hosts" ("id", "name", "ip", "userId") VALUES (1, \'h\', \'198.51.100.1\', 1)');
      const cols = '"id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "routeParentRuleId"';
      await runtime.executeRaw('INSERT INTO "forward_rules" (' + cols + ') VALUES (10, 1, \'parent-off\', \'iptables\', \'tcp\', 11000, \'203.0.113.1\', 80, 1, 0, NULL)');
      await runtime.executeRaw('INSERT INTO "forward_rules" (' + cols + ') VALUES (11, 1, \'parent-on\', \'iptables\', \'tcp\', 11001, \'203.0.113.1\', 80, 1, 1, NULL)');
      const relayOfOff = { id: 20, userId: 1, hostId: 1, isEnabled: true, routeParentRuleId: 10 };
      const relayOfOn = { id: 21, userId: 1, hostId: 1, isEnabled: true, routeParentRuleId: 11 };
      const relayOfMissing = { id: 22, userId: 1, hostId: 1, isEnabled: true, routeParentRuleId: 999 };
      const plain = { id: 23, userId: 1, hostId: 1, isEnabled: true, routeParentRuleId: null };
      const gated = await gateForwardRulesForRuntime([relayOfOff, relayOfOn, relayOfMissing, plain]);
      const byId = new Map(gated.map((rule) => [rule.id, rule]));
      assert.equal(byId.get(20).isEnabled, false, "a relay whose parent was stopped must stop too");
      assert.equal(byId.get(21).isEnabled, true);
      assert.equal(byId.get(22).isEnabled, false, "a relay whose parent is gone must not run");
      assert.equal(byId.get(23).isEnabled, true);
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "r.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
