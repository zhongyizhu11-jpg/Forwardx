import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 线路组面板以前拉 rules.list 全部规则，再在前端按 failoverEnabled 丢掉绝大多数。
 * 现在带 failoverOnly 在库里筛：结果必须和「全拉再按 routeGroupOf 过滤」完全一致。
 */
test("rules.list 的 failoverOnly 在服务端筛，结果和前端原来的过滤一致", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-rule-failover-only-"));
  const databasePath = path.join(directory, "rules.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'tenant', 'h', 'user')");
    await exec("INSERT INTO hosts (id, name, ip, userId, agentToken) VALUES (1, 'h', '192.0.2.1', 1, 't')");
    for (const [id, userId, failover] of [[1, 1, 1], [2, 1, 0], [3, 2, 1], [4, 2, 0], [5, 2, 1]]) {
      await exec(
        "INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, failoverEnabled) VALUES (?, 1, ?, 'gost', 'tcp', ?, '198.51.100.1', 80, ?, ?)",
        [id, "r" + id, 20000 + id, userId, failover],
      );
    }
    const { rulesRouter } = await import(url("server/routers/rules.ts"));
    const { routeGroupOf } = await import(url("shared/routeGroup.ts"));
    const call = (id, role) => rulesRouter.createCaller({ user: { id, role, username: "u" + id }, req: { headers: {} }, res: { setHeader: () => {} } });
    const ids = (rows) => rows.map((row) => Number(row.id));

    for (const [caller, input] of [[call(1, "admin"), { scope: "all" }], [call(2, "user"), {}]]) {
      const everything = await caller.list(input);
      const filtered = await caller.list({ ...input, failoverOnly: true });
      const expected = everything.filter((rule) => routeGroupOf(rule));
      assert.deepEqual(JSON.parse(JSON.stringify(filtered)), JSON.parse(JSON.stringify(expected)));
      assert.ok(filtered.length > 0 && filtered.length < everything.length, "测试前提：两种规则都有");
    }
    assert.deepEqual(ids(await call(2, "user").list({ failoverOnly: true })).sort(), [3, 5], "租户只拿到自己开了主备的规则");
    console.log("FAILOVER_ONLY_OK");
    await runtime.closeDatabase().catch(() => undefined);
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, NODE_ENV: "test" },
      timeout: 120000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /FAILOVER_ONLY_OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
