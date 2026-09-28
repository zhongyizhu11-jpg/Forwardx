import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("changing the profile email rejects someone else's address and clears verification", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-profile-email-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const users = await import(moduleUrl("server/repositories/userRepository.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const cols = ["id", "username", "password", "role", "email", "emailVerified"];
      const insert = (values) => runtime.executeRaw('INSERT INTO "users" (' + cols.map((c) => '"' + c + '"').join(", ") + ") VALUES (?, ?, ?, ?, ?, ?)", values);
      await insert([1, "alice", "x", "user", "alice@example.com", 1]);
      await insert([2, "bob", "x", "user", "bob@example.com", 1]);
      const row = async (id) => (await runtime.queryRaw('SELECT "email", "emailVerified" FROM "users" WHERE "id" = ?', [id]))[0];

      await assert.rejects(() => users.updateUserProfile(2, { email: "ALICE@example.com" }), /已被其他账户使用/);
      await assert.rejects(() => users.updateUserProfile(2, { email: "alice" }), /已被其他账户使用/, "another account's username is taken too");
      assert.equal((await row(2)).email, "bob@example.com");

      await users.updateUserProfile(2, { email: "bob.new@example.com" });
      assert.equal((await row(2)).email, "bob.new@example.com");
      assert.equal(Number((await row(2)).emailVerified), 0, "a new address is not verified");

      await runtime.executeRaw('UPDATE "users" SET "emailVerified" = 1 WHERE "id" = 1');
      await users.updateUserProfile(1, { email: "Alice@Example.com", name: "Alice" });
      assert.equal(Number((await row(1)).emailVerified), 1, "re-saving the same address (case aside) keeps verification");
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "p.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
