import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("an entry/exit group still used by a tunnel or chain cannot be deleted", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-delete-refs-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const service = await import(moduleUrl("server/services/forwardGroupService.ts"));
    const q = (name) => '"' + name + '"';
    const insert = (table, columns, values) => runtime.executeRaw(
      "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
      values,
    );
    const groupExists = async (id) => (await runtime.queryRaw('SELECT "id" FROM "forward_groups" WHERE "id" = ?', [id])).length > 0;
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await insert("users", ["id", "username", "password", "role"], [1, "admin", "x", "admin"]);
      for (const id of [1, 2]) await insert("hosts", ["id", "name", "ip", "userId"], [id, "h" + id, "198.51.100." + id, 1]);
      const groupCols = ["id", "name", "groupType", "groupMode", "domain", "targetIp", "userId", "isEnabled"];
      await insert("forward_groups", groupCols, [20, "entry", "host", "entry", "entry.example.test", "0.0.0.0", 1, 1]);
      await insert("forward_groups", groupCols, [21, "exit", "host", "exit", null, "0.0.0.0", 1, 1]);
      await insert("forward_groups", groupCols, [22, "unused-entry", "host", "entry", "unused.example.test", "0.0.0.0", 1, 1]);
      await insert("forward_groups", [...groupCols, "entryGroupId"], [23, "chain", "host", "chain", null, "0.0.0.0", 1, 1, 22]);
      await insert("tunnels", ["id", "name", "entryGroupId", "exitGroupId", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"], [30, "t", 20, 21, 1, 2, "tls", 25000, 1, 1]);

      await assert.rejects(() => service.deleteForwardGroupWithImpact(20), /隧道「t」/);
      await assert.rejects(() => service.deleteForwardGroupWithImpact(21), /隧道「t」/);
      await assert.rejects(() => service.deleteForwardGroupWithImpact(22), /转发链「chain」/);
      assert.equal(await groupExists(20) && await groupExists(21) && await groupExists(22), true);

      await runtime.executeRaw('DELETE FROM "tunnels" WHERE "id" = 30');
      await service.deleteForwardGroupWithImpact(21);
      assert.equal(await groupExists(21), false, "an unreferenced group can be deleted");
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "g.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
