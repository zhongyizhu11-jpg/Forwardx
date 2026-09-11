import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MIGRATION_TABLES, getDatabaseTableDefs } from "./dbSchema";

function runSqliteScript(script: string, env: Record<string, string>) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test("落地入站已登记进面板迁移，升级面板不会丢配置", () => {
  // 入站里存着 REALITY 私钥和全部凭据，漏登记会在迁移面板时静默丢失 ——
  // 而且丢了就再也生成不出同一个节点，所有客户端都要重新导入。
  assert.ok(MIGRATION_TABLES.includes("proxy_inbounds" as never));
});

test("入站用户表已登记进面板迁移", () => {
  // 用户凭据丢了就再也生成不出同一个节点，那一个人的所有客户端都要重新导入。
  assert.ok(MIGRATION_TABLES.includes("proxy_inbound_users" as never));
});

test("派生标记在 proxy_nodes 上", () => {
  const nodes = getDatabaseTableDefs().find((table) => table.name === "proxy_nodes");
  assert.ok(nodes);
  const columns = new Set(nodes!.columns.map((column) => column.name));
  // inboundId 非 0 表示这一行是入站派生出来的，手工改会在下次保存时被覆盖。
  assert.ok(columns.has("inboundId"));
  // inboundUserId 让派生节点跟用户对齐 —— 没有它，用户删掉后不知道该删哪条节点。
  assert.ok(columns.has("inboundUserId"));
});

test("全新数据库会建出落地入站需要的表和列", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-inbound-schema-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      import BetterSqlite3 from "better-sqlite3";
      const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const schema = await import(moduleUrl("server/dbSchema.ts"));

      const db = new BetterSqlite3(process.env.FORWARDX_TEST_DB);
      await schema.ensureDatabaseSchema(db);

      const columnsOf = (table) => new Set(db.prepare("PRAGMA table_info(" + table + ")").all().map((row) => row.name));

      const inbound = columnsOf("proxy_inbounds");
      for (const name of [
        "userId", "hostId", "name", "protocol", "port", "transport", "security",
        "uuid", "password", "method", "flow", "serverName", "certPath", "keyPath",
        "acmeEmail",
        "realityPrivateKey", "realityPublicKey", "realityShortId", "realityDest",
        "obfs", "obfsPassword", "upMbps", "downMbps", "congestionControl",
        "snellVersion", "snellMode", "isEnabled",
      ]) {
        assert.ok(inbound.has(name), "proxy_inbounds 缺列: " + name);
      }

      assert.ok(columnsOf("proxy_nodes").has("inboundId"), "proxy_nodes 缺列: inboundId");
      assert.ok(columnsOf("proxy_nodes").has("inboundUserId"), "proxy_nodes 缺列: inboundUserId");

      const inboundUser = columnsOf("proxy_inbound_users");
      for (const name of ["inboundId", "name", "uuid", "password", "sortOrder"]) {
        assert.ok(inboundUser.has(name), "proxy_inbound_users 缺列: " + name);
      }

      console.log("OK");
    `;
    const output = runSqliteScript(script, { FORWARDX_TEST_DB: path.join(directory, "forwardx.db") });
    assert.match(output, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("已有数据库升级时会补出新表和新列", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-inbound-upgrade-"));
  try {
    /**
     * 模拟从没有落地节点功能的旧版升上来：先按旧结构建库，再跑一次 schema 同步。
     * 自动迁移漏掉的话，用户升级后会看到「表不存在」，而不是一个空列表。
     */
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      import BetterSqlite3 from "better-sqlite3";
      const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const schema = await import(moduleUrl("server/dbSchema.ts"));

      const db = new BetterSqlite3(process.env.FORWARDX_TEST_DB);
      // 旧版的 proxy_nodes：没有 inboundId，也没有 proxy_inbounds 这张表。
      db.exec("CREATE TABLE proxy_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, userId INTEGER NOT NULL, name TEXT NOT NULL, address TEXT NOT NULL, port INTEGER NOT NULL)");
      db.prepare("INSERT INTO proxy_nodes (userId, name, address, port) VALUES (?, ?, ?, ?)").run(1, "旧节点", "1.2.3.4", 443);

      await schema.ensureDatabaseSchema(db);

      const columnsOf = (table) => new Set(db.prepare("PRAGMA table_info(" + table + ")").all().map((row) => row.name));
      assert.ok(columnsOf("proxy_nodes").has("inboundId"), "升级后 proxy_nodes 仍缺 inboundId");
      assert.ok(columnsOf("proxy_inbounds").has("realityPrivateKey"), "升级后没有建出 proxy_inbounds");
      assert.ok(columnsOf("proxy_inbound_users").has("password"), "升级后没有建出 proxy_inbound_users");

      // 老数据要原样还在，并且默认不是派生节点。
      const kept = db.prepare("SELECT name, inboundId FROM proxy_nodes WHERE userId = 1").get();
      assert.equal(kept.name, "旧节点");
      assert.equal(Number(kept.inboundId), 0);

      console.log("OK");
    `;
    const output = runSqliteScript(script, { FORWARDX_TEST_DB: path.join(directory, "forwardx.db") });
    assert.match(output, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
