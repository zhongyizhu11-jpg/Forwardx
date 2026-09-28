import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tunnelSecretSeed } from "./agentRouteUtils";

test("the tunnel secret fallback is no longer derivable from public ids", () => {
  const tunnel = { id: 7, entryHostId: 1, exitHostId: 2, secret: null };
  const legacyPredictable = crypto.createHash("sha256").update("forwardx-tunnel:7:1:2").digest("hex");
  assert.notEqual(tunnelSecretSeed(tunnel), legacyPredictable);
  assert.equal(tunnelSecretSeed(tunnel), tunnelSecretSeed({ ...tunnel }), "fallback stays stable within one panel");
  assert.equal(tunnelSecretSeed({ ...tunnel, secret: "abc" }), "abc");
});

test("schema ensure backfills random secrets for legacy tunnels without one", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-tunnel-secret-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const insert = 'INSERT INTO "tunnels" ("id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "secret") VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
      await runtime.executeRaw(insert, [1, "null-secret", 1, 2, "tls", 20001, 1, null]);
      await runtime.executeRaw(insert, [2, "empty-secret", 1, 2, "tls", 20002, 1, ""]);
      await runtime.executeRaw(insert, [3, "kept-secret", 1, 2, "tls", 20003, 1, "existing-secret"]);
      await schema.ensureDatabaseSchema();
      const rows = await runtime.queryRaw('SELECT "id", "secret" FROM "tunnels" ORDER BY "id"');
      assert.match(String(rows[0].secret), /^[a-f0-9]{64}$/);
      assert.match(String(rows[1].secret), /^[a-f0-9]{64}$/);
      assert.notEqual(rows[0].secret, rows[1].secret);
      assert.equal(rows[2].secret, "existing-secret");
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "tunnels.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
      encoding: "utf8",
      timeout: 90_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
