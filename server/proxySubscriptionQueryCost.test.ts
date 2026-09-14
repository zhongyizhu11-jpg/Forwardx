import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 组装一份订阅要打多少次库。
 *
 * 订阅地址是**没有登录态、按客户端节奏来**的一条路：默认十二小时刷一次不觉得，可
 * 客户端的刷新间隔是用户自己填的，一个商家几百个租户里总有人填几分钟。这条路上每
 * 多跑一条查询，就是几百倍地多跑。
 *
 * 之前这里白跑了两处：
 *
 * - 节点模板查了两遍 —— plan 里查一次，外面渲染文档时又查一次，而它们本来就是
 *   一次能查完的（每遍三条：自己的、别人分享的、独立凭据的）。
 * - 主机整表读 —— `select * from hosts` 不带条件，而实际用到的只有这些转发的入口机
 *   和这些自建节点所在的机器。
 *
 * 所以这一组不测「快不快」（那会变成一条看机器脸色的脆测试），只测**打了几次库、
 * 有没有不带条件的整表读**。
 */
test("SQLite 一次订阅组装不重复查模板，也不整表读主机", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sub-cost-"));
  const databasePath = path.join(directory, "sub-cost.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    // 必须在建库之前挂钩子：所有语句（drizzle 的和裸 SQL 的）都从 prepare 过。
    const Database = (await import("better-sqlite3")).default;
    const originalPrepare = Database.prototype.prepare;
    let recording = false;
    const statements = [];
    Database.prototype.prepare = function (sql) {
      if (recording) statements.push(String(sql));
      return originalPrepare.call(this, sql);
    };

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const subs = await import(url("server/repositories/proxySubscriptionRepository.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, p = []) => runtime.executeRaw(sql, p);

    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (1,'t','h','user',1)");
    for (let i = 1; i <= 6; i++) {
      await exec("INSERT INTO hosts (id,name,ip,ipv4,agentToken,userId) VALUES (?,?,?,?,?,1)",
        [i, "机器" + i, "10.0.0." + i, "10.0.0." + i, "tok" + i]);
    }
    for (let i = 1; i <= 3; i++) {
      await exec("INSERT INTO proxy_nodes (id,userId,name,protocol,address,port,uuid,tls,isEnabled,includeDirect) VALUES (?,1,?,'vless',?,443,'u',1,1,1)",
        [i, "节点" + i, "198.51.100." + i]);
    }
    // 只用到 1、2 两台机器：另外四台不该被读进来。
    for (let i = 1; i <= 2; i++) {
      await exec("INSERT INTO forward_rules (id,hostId,name,forwardType,protocol,sourcePort,targetIp,targetPort,userId,isEnabled,proxyNodeId,proxyNodeVisible) VALUES (?,?,?,'direct','tcp',?,?,443,1,1,?,1)",
        [i, i, "转发" + i, 20000 + i, "198.51.100." + i, i]);
    }

    // 预热一次（首次会有建表/兼容性检查之类的杂音），再开始计数。
    await subs.getProxySubscriptionDocumentForUser(1);
    statements.length = 0;
    recording = true;
    await subs.getProxySubscriptionDocumentForUser(1);
    recording = false;

    const touching = (table) => statements.filter((sql) => new RegExp('from\\s+"?' + table + '"?', "i").test(sql));

    /*
      查模板这一路一共三条：自己的（proxy_nodes）、别人分享的（proxy_node_shares）、
      独立凭据（proxy_inbound_users）。查两遍就会各变成两条 —— 所以按「各一条」订，
      而不是订一个宽松的上限（订宽了等于没订，我第一版就吃过这个亏）。
    */
    for (const table of ["proxy_nodes", "proxy_node_shares", "proxy_inbound_users"]) {
      const reads = touching(table);
      assert.equal(
        reads.length,
        1,
        table + " 被查了 " + reads.length + " 次，模板那一路多半又查了两遍：\n" + reads.join("\n"),
      );
    }

    const hostReads = touching("hosts");
    assert.equal(hostReads.length, 1, "主机只该查一次，实际 " + hostReads.length + " 条");
    assert.match(
      hostReads[0],
      /where/i,
      "主机必须带条件查 —— 不带条件就是每来一次订阅就把整张 hosts 表读一遍：\n" + hostReads[0],
    );

    // 总量也拦一道：这条路上任何新增的查询都该是有意识加的。
    /*
      总量也拦一道。真要新增查询就把这个数改大 —— 但先想清楚：这条路没有登录态、
      按客户端自己填的刷新间隔跑，多一条就是几百倍地多一条。
    */
    assert.ok(
      statements.length <= 5,
      "一次订阅组装打库次数超了（" + statements.length + " 条）：\n" + statements.join("\n"),
    );

    console.log("OK statements=" + statements.length);
    Database.prototype.prepare = originalPrepare;
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
