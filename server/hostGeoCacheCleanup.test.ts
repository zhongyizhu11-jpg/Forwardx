import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 地理缓存的 expiresAt 写入时就已经是「抓取时间 + 30 天」，过了就再也不会被读。
 * 清理原来又往回减了 30 天，过期行要白白多躺一个月。
 */
test("过期的地理缓存行按 expiresAt <= 现在 清掉，没过期的留着", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-geo-cleanup-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const geo = await import(url("server/hostGeo.ts"));

      const now = Math.floor(Date.now() / 1000);
      const insert = (address, expiresAt) => runtime.executeRaw(
        'INSERT INTO ip_geo_cache (address, "resolvedAddress", "geoCountryCode", "fetchedAt", "expiresAt") VALUES (?, ?, ?, ?, ?)',
        [address, address, "US", now - 40 * 86400, expiresAt],
      );
      await insert("expired-yesterday.example", now - 86400);
      await insert("expired-long-ago.example", now - 60 * 86400);
      await insert("fresh.example", now + 86400);

      await geo.cleanOldAddressGeoCache();
      const left = (await runtime.queryRaw("SELECT address FROM ip_geo_cache ORDER BY address")).map((row) => row.address);
      assert.deepEqual(left, ["fresh.example"], "昨天就过期、再也不会被读的行不该再留一个月");
      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "geo.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
