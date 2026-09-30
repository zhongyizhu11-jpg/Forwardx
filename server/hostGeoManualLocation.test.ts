import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 主机位置：手动指定 + 三家定位服务兜底。
 *
 * 用户抱怨地图上「中国、台湾、香港还有美国」的机器都放错了地方，还有一台
 * 根本没定到位。根源两条：机房网段在 IP 库里本来就不准；ipapi.co 一限流，
 * 那台机器就一直空着。这里把整条链路放在真 sqlite 上过一遍：
 *   - geoManual 列老库能自动补上、默认 false
 *   - setLocation 的校验（经纬度范围、ISO 代码）和权限
 *   - 手动定位的主机，自动刷新和补漏扫描都绕开（fetch 一次都不该被调）
 *   - 三家服务按顺序兜底，限流状态各记各的
 *   - relocate 清掉手动标记并立刻重查
 */

type Probe = {
  schema: { legacyColumnRestored: boolean; defaultValue: unknown; exists: boolean };
  validation: { badLat: string; badLng: string; badCode: string; foreign: string; ok: any };
  listRow: { geoSource: string | null; geoManual: boolean; geoRegion: string | null };
  manualSkip: { fetchCalls: number; region: string | null; manual: boolean; sweep: any };
  fallback: {
    first: { provider: string | null; country: string; region: string | null; hosts: string[] };
    statesAfterFirst: Record<string, boolean>;
    second: { provider: string | null; hosts: string[] };
    third: { provider: string | null; hosts: string[] };
    cacheProviders: string[];
  };
  backoff: { attemptsAfterFail: number; delayMinutes: number; secondDelayMinutes: number };
  relocate: { manualAfter: boolean; source: string | null; fetchHosts: string[]; region: string | null };
  entryChange: { manualKept: boolean; region: string | null };
};

function runProbe(): Probe {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-geo-manual-"));
  const databasePath = path.join(directory, "geo.db");
  const script = String.raw`
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);
    const out = {};

    // ---- 老库补列：把列删掉再跑一次自动迁移，列要回来、默认 false ----
    await exec('ALTER TABLE "hosts" DROP COLUMN "geoManual"');
    await schema.ensureDatabaseSchema();
    const columns = await query('PRAGMA table_info("hosts")');
    const geoManualColumn = columns.find((column) => column.name === "geoManual");
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'tenant', 'hash', 'user')");
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId") VALUES (1, ?, ?, ?, ?, ?, 1)',
      ["自动机", "8.8.8.8", "8.8.8.8", "slave", "tok1"],
    );
    const inserted = await query('SELECT "geoManual" FROM hosts WHERE id = 1');
    out.schema = {
      legacyColumnRestored: !!geoManualColumn,
      defaultValue: inserted[0]?.geoManual,
      exists: !!geoManualColumn,
    };
    // 自动机先标成「刚定位过」：后面调 hosts.list 会顺手触发刷新，别让它把 fetch 记录搅浑
    await exec('UPDATE hosts SET "geoCountryCode" = ?, "geoLatitudeMicro" = ?, "geoLongitudeMicro" = ?, "geoUpdatedAt" = ? WHERE id = 1', ["US", 1, 1, Math.floor(Date.now() / 1000)]);

    // ---- fetch 打桩：按 URL 判断是哪家服务 ----
    const fetchLog = [];
    let plan = {};
    globalThis.fetch = async (input) => {
      const target = String(input);
      const host = new URL(target).host;
      fetchLog.push(host);
      const step = plan[host];
      if (!step) throw new Error("unexpected fetch " + host);
      if (typeof step === "function") return step(target);
      return step;
    };
    const jsonResponse = (status, body) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });

    const geo = await import(url("server/hostGeo.ts"));
    const hostsModule = await import(url("server/routers/hosts.ts"));
    const db = await import(url("server/db.ts"));
    const caller = (user) => hostsModule.hostsRouter.createCaller({
      user,
      req: { headers: {} },
      res: { setHeader: () => {} },
    });
    const admin = { id: 1, role: "admin", username: "admin" };
    const tenant = { id: 2, role: "user", username: "tenant" };
    const message = async (promise) => {
      try { await promise; return "OK"; } catch (error) { return String(error?.message || error); }
    };

    // ---- setLocation 校验 + 权限 ----
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId") VALUES (2, ?, ?, ?, ?, ?, 1)',
      ["手动机", "1.1.1.1", "1.1.1.1", "slave", "tok2"],
    );
    out.validation = {
      badLat: await message(caller(admin).setLocation({ id: 2, geoCountryCode: "HK", geoLatitude: 91, geoLongitude: 114 })),
      badLng: await message(caller(admin).setLocation({ id: 2, geoCountryCode: "HK", geoLatitude: 22, geoLongitude: 181 })),
      badCode: await message(caller(admin).setLocation({ id: 2, geoCountryCode: "H1", geoLatitude: 22, geoLongitude: 114 })),
      foreign: await message(caller(tenant).setLocation({ id: 2, geoCountryCode: "HK", geoLatitude: 22, geoLongitude: 114 })),
      ok: await caller(admin).setLocation({ id: 2, geoCountryCode: "hk", geoRegion: "香港", geoLatitude: 22.3193, geoLongitude: 114.1694 }),
    };
    const listRow = (await caller(admin).list()).find((row) => Number(row.id) === 2);
    out.listRow = { geoSource: listRow?.geoSource ?? null, geoManual: !!listRow?.geoManual, geoRegion: listRow?.geoRegion ?? null };

    // ---- 手动的主机：刷新和补漏都不碰它，fetch 一次都不该调 ----
    plan = { "ipapi.co": () => { throw new Error("should not be called"); } };
    geo.scheduleHostGeoRefresh([await db.getHostById(2)]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const sweepWithOnlyManual = await geo.runHostGeoSweep();
    const manualRow = await db.getHostById(2);
    out.manualSkip = { fetchCalls: fetchLog.length, region: manualRow?.geoRegion ?? null, manual: !!manualRow?.geoManual, sweep: sweepWithOnlyManual };

    // ---- 三家兜底：ipapi.co 429 → ip-api.com 答上 ----
    geo.resetHostGeoStateForTests();
    fetchLog.length = 0;
    plan = {
      "ipapi.co": jsonResponse(429, {}),
      "ip-api.com": jsonResponse(200, { status: "success", country: "United States", countryCode: "US", regionName: "California", city: "Los Angeles", lat: 34.05, lon: -118.24 }),
    };
    const first = await geo.lookupAddressGeo("8.8.8.8");
    const statesAfterFirst = Object.fromEntries(geo.getGeoProviderStates().map((state) => [state.name, state.rateLimitedUntil > Date.now()]));
    const firstHosts = fetchLog.slice();

    // 同一轮里再查另一个地址：ipapi.co 在冷却期内直接跳过，不再打它
    fetchLog.length = 0;
    plan = {
      "ip-api.com": jsonResponse(200, { status: "fail", message: "private range" }),
      "ipwho.is": jsonResponse(200, { success: true, country: "Japan", country_code: "JP", region: "Tokyo", city: "Tokyo", latitude: 35.68, longitude: 139.69, flag: { emoji: "🇯🇵" } }),
    };
    const second = await geo.lookupAddressGeo("9.9.9.9");
    const secondHosts = fetchLog.slice();

    // 全部失败：三家都试过，返回 null 而不是抛
    fetchLog.length = 0;
    plan = {
      "ip-api.com": jsonResponse(500, {}),
      "ipwho.is": jsonResponse(200, { success: false, message: "Invalid IP address" }),
    };
    const third = await geo.lookupAddressGeo("4.2.2.2");
    const thirdHosts = fetchLog.slice();
    const cacheRows = await query('SELECT address, provider FROM ip_geo_cache ORDER BY address');
    out.fallback = {
      first: { provider: first?.provider ?? null, country: first?.geoCountryCode ?? "", region: first?.geoRegion ?? null, hosts: firstHosts },
      statesAfterFirst,
      second: { provider: second?.provider ?? null, hosts: secondHosts },
      third: { provider: third?.provider ?? null, hosts: thirdHosts },
      cacheProviders: cacheRows.map((row) => row.address + "=" + row.provider),
    };

    // ---- 退避：查不到的主机记一次失败，下次要等；再失败翻倍 ----
    geo.resetHostGeoStateForTests();
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId") VALUES (3, ?, ?, ?, ?, ?, 1)',
      ["查不到", "208.67.222.222", "208.67.222.222", "slave", "tok3"],
    );
    plan = { "ipapi.co": jsonResponse(500, {}), "ip-api.com": jsonResponse(500, {}), "ipwho.is": jsonResponse(500, {}) };
    await geo.runHostGeoSweep();
    const retry1 = geo.getHostGeoRetryState(3);
    const firstDelayMinutes = Math.round((retry1.notBefore - Date.now()) / 60000);
    const sweepDuringBackoff = await geo.runHostGeoSweep();
    // 把退避时间拨到过去，再失败一次看是否翻倍
    retry1.notBefore = Date.now() - 1;
    await geo.runHostGeoSweep();
    const retry2 = geo.getHostGeoRetryState(3);
    out.backoff = {
      attemptsAfterFail: retry1?.attempts ?? 0,
      delayMinutes: sweepDuringBackoff.attempted === 0 ? firstDelayMinutes : -1,
      secondDelayMinutes: Math.round((retry2.notBefore - Date.now()) / 60000),
    };

    // ---- relocate：清手动标记、立刻重查 ----
    geo.resetHostGeoStateForTests();
    fetchLog.length = 0;
    plan = {
      "ipapi.co": jsonResponse(200, { country_code: "SG", country_name: "Singapore", region: "Singapore", latitude: 1.35, longitude: 103.82 }),
    };
    const relocated = await caller(admin).relocate({ id: 2 });
    const relocatedRow = await db.getHostById(2);
    out.relocate = { manualAfter: !!relocatedRow?.geoManual, source: relocated.geoSource, fetchHosts: fetchLog.slice(), region: relocatedRow?.geoRegion ?? null };

    // ---- 换入口地址：手动位置不被清掉 ----
    await caller(admin).update({ id: 2, geoManual: true, geoCountryCode: "HK", geoRegion: "香港", geoLatitude: 22.3193, geoLongitude: 114.1694 });
    await caller(admin).update({ id: 2, entryIp: "64.6.64.6" });
    const afterEntry = await db.getHostById(2);
    out.entryChange = { manualKept: !!afterEntry?.geoManual, region: afterEntry?.geoRegion ?? null };

    console.log("GEOPROBE " + JSON.stringify(out));
    await runtime.closeDatabase().catch(() => undefined);
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FORWARDX_LOG_DIR: path.join(directory, "logs") },
    timeout: 180_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("GEOPROBE "));
  assert.ok(line, `没拿到探测结果：\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice("GEOPROBE ".length)) as Probe;
}

const probe = runProbe();

test("geoManual 列：老库自动补上，默认 false", () => {
  assert.equal(probe.schema.exists, true);
  assert.equal(probe.schema.legacyColumnRestored, true, "删掉再跑 ensureDatabaseSchema 要能补回来");
  assert.equal(Number(probe.schema.defaultValue), 0, "没指定时默认不是手动");
});

test("setLocation：经纬度范围、ISO 代码都要查，外人不能改", () => {
  assert.match(probe.validation.badLat, /纬度/);
  assert.match(probe.validation.badLng, /经度/);
  assert.match(probe.validation.badCode, /ISO/);
  assert.match(probe.validation.foreign, /无权/);
  assert.equal(probe.validation.ok.geoSource, "manual");
  assert.equal(probe.validation.ok.geoCountryCode, "HK", "小写代码要归一成大写");
  assert.equal(probe.validation.ok.geoCountryName, "中国香港");
  assert.equal(probe.validation.ok.geoLatitudeMicro, 22319300);
  assert.equal(probe.listRow.geoSource, "manual", "hosts.list 的行要带 geoSource");
  assert.equal(probe.listRow.geoManual, true);
  assert.equal(probe.listRow.geoRegion, "香港");
});

test("手动定位的主机：列表刷新和补漏扫描都不去查，位置不动", () => {
  assert.equal(probe.manualSkip.fetchCalls, 0, "fetch 一次都不该被调");
  assert.equal(probe.manualSkip.manual, true);
  assert.equal(probe.manualSkip.region, "香港");
  assert.equal(probe.manualSkip.sweep.attempted, 0);
});

test("三家服务按顺序兜底，限流状态各记各的", () => {
  assert.deepEqual(probe.fallback.first.hosts, ["ipapi.co", "ip-api.com"], "ipapi.co 429 之后换 ip-api.com");
  assert.equal(probe.fallback.first.provider, "ip-api.com");
  assert.equal(probe.fallback.first.country, "US");
  assert.equal(probe.fallback.first.region, "California");
  assert.deepEqual(probe.fallback.statesAfterFirst, { "ipapi.co": true, "ip-api.com": false, "ipwho.is": false }, "只有 ipapi.co 进冷却");
  assert.deepEqual(probe.fallback.second.hosts, ["ip-api.com", "ipwho.is"], "冷却中的 ipapi.co 直接跳过；ip-api.com status=fail 再换 ipwho.is");
  assert.equal(probe.fallback.second.provider, "ipwho.is");
  assert.deepEqual(probe.fallback.third.hosts, ["ip-api.com", "ipwho.is"]);
  assert.equal(probe.fallback.third.provider, null, "全失败返回 null，不抛");
  assert.deepEqual(probe.fallback.cacheProviders, ["8.8.8.8=ip-api.com", "9.9.9.9=ipwho.is"], "缓存行记下是哪家给的");
});

test("查不到的主机按指数退避重试，封顶 6 小时", () => {
  assert.equal(probe.backoff.attemptsAfterFail, 1);
  assert.equal(probe.backoff.delayMinutes, 10, "第一次失败后等 10 分钟，期间扫描不再试它");
  assert.equal(probe.backoff.secondDelayMinutes, 20, "第二次翻倍");
});

test("relocate：清掉手动标记并立刻按 IP 重查", () => {
  assert.equal(probe.relocate.manualAfter, false);
  assert.deepEqual(probe.relocate.fetchHosts, ["ipapi.co"]);
  assert.equal(probe.relocate.source, "auto");
  assert.equal(probe.relocate.region, "Singapore");
});

test("换入口地址不清手动位置", () => {
  assert.equal(probe.entryChange.manualKept, true);
  assert.equal(probe.entryChange.region, "香港");
});
