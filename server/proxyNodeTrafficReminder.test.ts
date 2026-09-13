import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 落地节点跑到量了要有人知道。
 *
 * 那个「总流量」原来纯是个仪表盘：填了 500G，用到 700G 也照常服务，除了界面上一个
 * 红色小图标什么都不会发生。而这个数字通常来自机房 —— 跑超之后是机房把机器停掉，
 * 客户端里这条线路直接断，商家往往等客户找上门才知道。
 *
 * 这一组盯两件事：查得准（没设上限的、没到量的都不能查出来），以及去重键带状态
 * （先发过「快满」，当天真跑满时那一封更要紧，不能被顶掉）。
 */
test("SQLite 只查到量的节点，且快满与已满是两条不同的提醒", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-node-reminder-"));
  const databasePath = path.join(directory, "node-reminder.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const subs = await import(url("server/repositories/proxySubscriptionRepository.ts"));
    const { planProxyNodeTrafficReminder, proxyNodeTrafficReminderKey } =
      await import(url("shared/proxyNodeReminder.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    await runtime.executeRaw(
      'INSERT INTO "users" ("id", "username", "password", "role") VALUES (?, ?, ?, ?)',
      [2, "tenant", "hash", "user"],
    );

    const GB = 1024 ** 3;
    const makeNode = async (name, trafficLimit, trafficUsed) => Number(await subs.createProxyNode({
      userId: 2, name, protocol: "vless", address: "198.51.100.5", port: 443,
      uuid: "11111111-2222-3333-4444-555555555555", transport: "tcp", tls: true,
      isEnabled: true, trafficLimit, trafficUsed,
    }));

    const noLimit = await makeNode("没设上限", 0, 900 * GB);
    const plenty = await makeNode("还很宽裕", 100 * GB, 10 * GB);
    const nearly = await makeNode("快满了", 100 * GB, 85 * GB);
    const over = await makeNode("已经超了", 100 * GB, 140 * GB);

    const rows = await subs.getProxyNodesWithTrafficQuota();
    const ids = rows.map((row) => Number(row.id)).sort((a, b) => a - b);
    assert.deepEqual(
      ids,
      [plenty, nearly, over].sort((a, b) => a - b),
      "没设上限的节点不该被查出来 —— 它谈不上到量，读回来只是白读",
    );

    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    assert.equal(planProxyNodeTrafficReminder(byId.get(plenty)).due, false);
    assert.equal(planProxyNodeTrafficReminder(byId.get(nearly)).state, "warn");
    assert.equal(planProxyNodeTrafficReminder(byId.get(over)).state, "exceeded");

    // 用量是从数据库读回来的真实字节数，不是构造出来的对象。
    assert.equal(planProxyNodeTrafficReminder(byId.get(over)).usedPercent, 140);

    // 去重键：同一个节点先「快满」后「已满」是两把钥匙。
    const warnKey = proxyNodeTrafficReminderKey(nearly, "warn");
    const overKey = proxyNodeTrafficReminderKey(nearly, "exceeded");
    assert.notEqual(warnKey, overKey);
    await runtime.executeRaw('INSERT INTO "system_settings" ("key", "value") VALUES (?, ?)', [warnKey, "sent"]);
    const stored = await runtime.queryRaw('SELECT "key" FROM "system_settings" WHERE "key" = ?', [overKey]);
    assert.equal(stored.length, 0, "发过「快满」不该顶掉「已满」那一封");

    console.log("OK");
    await runtime.closeDatabase();
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 90_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
