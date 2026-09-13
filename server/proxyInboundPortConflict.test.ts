import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 落地节点占的端口，转发规则那边也得认。
 *
 * 转发规则和落地入站是两个进程，各自 bind 各自的端口，谁也不知道对方存在。面板
 * 是唯一知道两边的人 —— 它不拦，用户就能在同一台机器上建一条同端口的转发：一路
 * 提示成功，到了机器上后起的那个 bind 失败，而界面上两边都显示正常，要人上机器
 * 看日志才知道为什么。
 */
function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-inbound-port-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      const tunnels = await import(url("server/repositories/tunnelRepository.ts"));
      const inbounds = await import(url("server/repositories/proxyInboundRepository.ts"));

      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      const query = (sql, params = []) => runtime.queryRaw(sql, params);

      await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'alice', 'hash', 'admin')");
      await exec("INSERT INTO hosts (id, name, ip, ipv4, agentToken, userId) VALUES (10, 'hk', '1.2.3.4', '1.2.3.4', 'tok', 1)");

      const makeInbound = async (port, isEnabled = true) => Number(await inbounds.createProxyInbound({
        userId: 1, hostId: 10, name: "HK-" + port, protocol: "vless", port,
        transport: "tcp", security: "none",
        uuid: "11111111-2222-3333-4444-555555555555", isEnabled,
      }));

      ${body}

      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "ports.db") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("落地节点在听的端口，转发规则这边算作已占用", () => {
  runInDatabase(String.raw`
    await makeInbound(443);
    assert.equal(await tunnels.isPortUsedOnHost(10, 443), true, "同一台机器上这个端口已经有人在听了");
    assert.ok((await tunnels.getUsedPortsOnHost(10)).has(443));
    // 别的端口不受影响。
    assert.equal(await tunnels.isPortUsedOnHost(10, 444), false);
  `);
});

test("不按协议放行：入站可能 TCP/UDP 都用", () => {
  runInDatabase(String.raw`
    await makeInbound(443);
    // Hysteria2 / TUIC 是 UDP，VLESS 是 TCP，XHTTP 两个都要 —— 分不清就一律当占用。
    // 少给一个端口是小事；撞上了要人上机器看日志才知道原因。
    assert.equal(await tunnels.isPortUsedOnHost(10, 443, undefined, "udp"), true);
    assert.equal(await tunnels.isPortUsedOnHost(10, 443, undefined, "tcp"), true);
  `);
});

test("停用的入站不挡路 —— 它没在听", () => {
  runInDatabase(String.raw`
    const id = await makeInbound(443);
    assert.equal(await tunnels.isPortUsedOnHost(10, 443), true);
    await inbounds.updateProxyInbound(id, { isEnabled: false });
    // 挡着反而让人以为端口被莫名占了，而界面上那条入站明明是灰的。
    assert.equal(await tunnels.isPortUsedOnHost(10, 443), false);
  `);
});

test("只挡自己那台机器", () => {
  runInDatabase(String.raw`
    await exec("INSERT INTO hosts (id, name, ip, ipv4, agentToken, userId) VALUES (11, 'sg', '5.6.7.8', '5.6.7.8', 'tok2', 1)");
    await makeInbound(443);
    assert.equal(await tunnels.isPortUsedOnHost(11, 443), false, "别的机器上的同号端口不相干");
  `);
});

test("反过来也成立：给落地节点挑端口时躲开转发规则", () => {
  runInDatabase(String.raw`
    // 这条本来就有，一起钉住 —— 两个方向都躲，才不会出现「A 躲 B、B 不躲 A」。
    await exec("INSERT INTO forward_rules (id, userId, name, hostId, sourcePort, targetIp, targetPort, isEnabled, pendingDelete, isForwardGroupTemplate) VALUES (100, 1, 'r', 10, 20000, '8.8.8.8', 53, 1, 0, 0)");
    const port = await inbounds.pickFreeInboundPort(10);
    assert.notEqual(port, 20000, "这个端口上已经有一条转发在听了");
    assert.ok(port >= 20000 && port <= 30000);
  `);
});

test("删主机时，它上面的落地节点、派生节点、分享一起清掉", () => {
  runInDatabase(String.raw`
    const hosts = await import(url("server/repositories/hostRepository.ts"));
    const shares = await import(url("server/repositories/proxySubscriptionRepository.ts"));
    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (2, 'bob', 'hash', 'user', 1)");

    const inboundId = await makeInbound(443);
    await inbounds.replaceProxyInboundUsers(inboundId, [
      { id: 0, name: "自己", uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", password: "" },
    ]);
    await inbounds.syncProxyNodeFromInbound(inboundId);
    const anchorId = Number((await query("SELECT id FROM proxy_nodes WHERE inboundId = ? ORDER BY id LIMIT 1", [inboundId]))[0].id);
    await shares.setProxyNodeSharesForUser(2, [anchorId], { label: "bob" });
    assert.equal((await shares.getProxyNodesForSubscription(2)).length, 1);

    await hosts.deleteHost(10);

    /**
     * 不清的话：入站行指向一台已经不存在的主机（「新建节点」那一段还会列出来，
     * 地址解析不出来），派生节点继续待在订阅里 —— 租户客户端里多一条永远连不上
     * 的线路，而管理端看上去一切正常。
     */
    assert.equal(Number((await query("SELECT COUNT(*) AS n FROM proxy_inbounds"))[0].n), 0);
    assert.equal(Number((await query("SELECT COUNT(*) AS n FROM proxy_nodes"))[0].n), 0);
    assert.equal(Number((await query("SELECT COUNT(*) AS n FROM proxy_node_shares"))[0].n), 0);
    assert.equal((await shares.getProxyNodesForSubscription(2)).length, 0, "租户订阅里也要跟着消失");
  `);
});
