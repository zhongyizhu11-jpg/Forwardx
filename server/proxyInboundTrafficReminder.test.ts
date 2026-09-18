import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 落地端口到量了也要有人知道 —— 而且不能把节点那条提醒顶掉。
 *
 * 面板里能设总流量的一共三层：主机（机房账单口径）、落地端口（面板自己开的那个
 * 监听端口）、落地节点（粘进来的那一条）。主机和节点都会发邮件和 Telegram，
 * **端口有额度、有累加、行上到量会变红，唯独不提醒** —— 填了 500G 的人以为面板
 * 在替他看着，其实只有他自己盯着那一页时才看得见。
 *
 * 两张表各有各的自增 id，所以去重键必须分命名空间：5 号端口和 5 号节点同一天
 * 都到量时，共用一个键会让后到的那条被当成「今天发过了」而永远发不出去。
 */
test("SQLite 落地端口到量会进提醒清单，且与同号节点各记各的", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-inbound-reminder-"));
  const databasePath = path.join(directory, "inbound-reminder.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const inbounds = await import(url("server/repositories/proxyInboundRepository.ts"));
    const subs = await import(url("server/repositories/proxySubscriptionRepository.ts"));
    const { collectDueProxyTrafficReminders } = await import(url("server/proxyTrafficReminders.ts"));
    const { proxyTrafficReminderKey } = await import(url("shared/proxyNodeReminder.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);

    await exec('INSERT INTO "users" ("id", "username", "password", "role") VALUES (?, ?, ?, ?)', [2, "tenant", "hash", "user"]);
    await exec(
      'INSERT INTO "hosts" ("id", "name", "ip", "ipv4", "agentToken", "userId") VALUES (?, ?, ?, ?, ?, ?)',
      [10, "东京落地", "203.0.113.10", "203.0.113.10", "tok10", 2],
    );

    const GB = 1024 ** 3;
    const makeInbound = async (name, port, trafficLimit, trafficUsed) => Number(await inbounds.createProxyInbound({
      userId: 2, hostId: 10, name, protocol: "vless", port,
      transport: "tcp", security: "reality", isEnabled: true,
      trafficLimit, trafficUsed,
    }));

    const noLimit = await makeInbound("没设上限", 10443, 0, 900 * GB);
    const plenty = await makeInbound("还很宽裕", 10444, 100 * GB, 10 * GB);
    const nearly = await makeInbound("快满了", 10445, 100 * GB, 85 * GB);
    const over = await makeInbound("已经超了", 10446, 100 * GB, 140 * GB);
    void noLimit;
    void plenty;

    const quotaIds = (await inbounds.getProxyInboundsWithTrafficQuota())
      .map((row) => Number(row.id))
      .sort((a, b) => a - b);
    assert.deepEqual(
      quotaIds,
      [plenty, nearly, over].sort((a, b) => a - b),
      "没设总量的端口不该被查出来 —— 它谈不上到量，读回来只是白读",
    );

    const due = await collectDueProxyTrafficReminders();
    const dueInbounds = due.filter((subject) => subject.scope === "inbound");
    assert.deepEqual(
      dueInbounds.map((subject) => subject.id).sort((a, b) => a - b),
      [nearly, over].sort((a, b) => a - b),
      "端口到量了却没进提醒清单：界面上变红了，而没有任何人被告知",
    );

    const overSubject = dueInbounds.find((subject) => subject.id === over);
    assert.equal(overSubject.plan.state, "exceeded");
    assert.equal(overSubject.kindText, "落地端口");
    assert.match(
      overSubject.label,
      /东京落地:10446/,
      "提醒里要说得出是哪台机器上的哪个端口，只给一个端口名认不出来",
    );

    /**
     * 同号撞车：造一个 id 和某个到量端口相同的到量节点，两条都要在清单里，
     * 且去重键不同。
     */
    const nodeId = over;
    await exec(
      'INSERT INTO "proxy_nodes" ("id", "userId", "name", "protocol", "address", "port", "trafficLimit", "trafficUsed", "isEnabled")'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [nodeId, 2, "粘来的落地", "vless", "198.51.100.5", 443, 100 * GB, 140 * GB, 1],
    );
    void subs;

    const both = await collectDueProxyTrafficReminders();
    const sameId = both.filter((subject) => subject.id === nodeId);
    assert.equal(sameId.length, 2, "同号的端口和节点都到量时，两条都要发");
    const keys = new Set(sameId.map((subject) => subject.dedupeKey));
    assert.equal(
      keys.size,
      2,
      "同号的端口和节点共用了一个去重键：后到的那条会被当成今天已经发过，永远发不出去",
    );
    assert.equal(proxyTrafficReminderKey("node", 5, "exceeded"), "proxyNodeTraffic:5:exceeded");
    assert.equal(proxyTrafficReminderKey("inbound", 5, "exceeded"), "proxyInboundTraffic:5:exceeded");

    console.log("OK");
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /OK/);
});
