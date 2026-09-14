import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 主机卡片上那行「计费」说的得是真的。
 *
 * 「这台机器上的转发扣的是钱还是套餐流量」——第一版我去查了**主机**上的计费配置，
 * 于是新部署上每台都显示「走套餐流量」。可界面里主机那一档早就禁用了（legacy_host /
 * 旧版本主机计费资源），现在能新建的只有转发组 / 隧道 / 转发链，配置全挂在那边。
 * 换句话说：一个关于钱的结论，在最常见的配法下恒定说反。
 *
 * 所以这条测试盯的是**按转发组配的价**能不能在主机列表上显示出来——不是「函数会不会
 * 返回点什么」。
 */
test("按转发组配的计费，要在主机列表上显示成按量计费", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-billing-"));
  const databasePath = path.join(directory, "host-billing.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const billing = await import(url("server/repositories/trafficBillingRepository.ts"));
    const { hostsRouter } = await import(url("server/routers/hosts.ts"));

    const callerFor = (user) => hostsRouter.createCaller({
      req: { headers: {} },
      res: { clearCookie() {} },
      user,
      authSession: null,
      authFailureReason: null,
    });
    const admin = { id: 1, username: "admin", role: "admin", accountEnabled: true };
    const tenant = { id: 2, username: "tenant", role: "user", accountEnabled: true };

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, p = []) => runtime.executeRaw(sql, p);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'tenant', 'hash', 'user')");
    // 三台机器：一台上的转发按转发组计费，一台按隧道计费，一台什么都没配。
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (10, '组计费机', '127.0.0.10', 'slave', 'tok10', 2)");
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (20, '隧道计费机', '127.0.0.20', 'slave', 'tok20', 2)");
    await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (30, '套餐机', '127.0.0.30', 'slave', 'tok30', 2)");
    await exec("INSERT INTO forward_groups (id, name, groupType, groupMode, targetIp, userId, isEnabled) VALUES (7, '香港组', 'host', 'failover', '127.0.0.1', 2, 1)");
    await exec("INSERT INTO tunnels (id, name, entryHostId, exitHostId, listenPort, userId) VALUES (8, '日本隧道', 10, 20, 9000, 2)");

    const rule = (id, hostId, extra) => exec(
      "INSERT INTO forward_rules (id, hostId, name, sourcePort, targetIp, targetPort, userId, tunnelId, forwardGroupId, pendingDelete) VALUES (?, ?, ?, ?, '127.0.0.1', 8080, 2, ?, ?, ?)",
      [id, hostId, "rule" + id, 10000 + id, extra.tunnelId ?? null, extra.forwardGroupId ?? null, extra.pendingDelete ? 1 : 0],
    );
    await rule(101, 10, { forwardGroupId: 7 });
    await rule(102, 10, {});                       // 同一台机器上没配计费的那条
    await rule(201, 20, { tunnelId: 8 });
    await rule(301, 30, {});
    // 已经删掉、只等 Agent 确认的那条不该再影响「现在怎么计费」
    await rule(302, 30, { forwardGroupId: 7, pendingDelete: true });

    await billing.setTrafficBillingEnabled(true);
    await billing.upsertTrafficBillingConfig({
      resourceType: "forward_group", resourceId: 7, enabled: true, pricePerGbMilliCents: 50000,
    });
    await billing.upsertTrafficBillingConfig({
      resourceType: "tunnel", resourceId: 8, enabled: true, pricePerGbMilliCents: 50000,
    });

    const pageFor = async (user) => {
      const page = await callerFor(user).listPage({ cursor: 0, limit: 50 });
      return new Map(page.items.map((item) => [Number(item.id), item]));
    };
    let rows = await pageFor(admin);

    assert.deepEqual(
      rows.get(10).trafficBilling,
      { billedRules: 1, totalRules: 2, pricePerGbMilliCents: 50000 },
      "转发组上配的价必须看得见 —— 只查主机那一档的话这里会是 null",
    );
    assert.deepEqual(
      rows.get(20).trafficBilling,
      { billedRules: 1, totalRules: 1, pricePerGbMilliCents: 50000 },
      "隧道上配的价同样算按量计费",
    );
    assert.equal(
      rows.get(30).trafficBilling,
      null,
      "什么都没配的机器才是走套餐流量；等删除确认的那条转发不算数",
    );

    // 非管理员看得到「在计费」，但看不到价钱 —— 服务端就不给。
    await exec("INSERT INTO user_host_permissions (userId, hostId) VALUES (2, 10)").catch(() => {});
    rows = await pageFor(tenant);
    assert.equal(rows.get(10).trafficBilling.billedRules, 1);
    assert.equal(rows.get(10).trafficBilling.pricePerGbMilliCents, 0, "价钱是商家的事，别透给租户");

    /*
      总开关关掉就一分钱都不扣（agentReportRoutes 里是同一个判断）。卡片上还挂着
      「按量计费 ¥0.5/GB」就是在骗人：管理员会以为这台机器在收钱。
    */
    await billing.setTrafficBillingEnabled(false);
    rows = await pageFor(admin);
    assert.equal(rows.get(10).trafficBilling, null, "总开关关着时不能还说在按量计费");
    assert.equal(rows.get(20).trafficBilling, null);

    console.log("HOST_BILLING_OK");
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, NODE_ENV: "test" },
      timeout: 120000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /HOST_BILLING_OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
