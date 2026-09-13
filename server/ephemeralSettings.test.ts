import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 「一天只做一次」的日标记要能被清掉。
 *
 * 到期提醒、流量提醒、主机续费提醒、余额自动续费都会往 system_settings 里写一行
 * `<前缀>:<...>:<YYYY-MM-DD>` 防重复，写完从来没人删。五百人的面板跑一年能攒十万
 * 行，而 getAllSettings() 是整表读、几十处在调 —— 这些垃圾每次缓存过期都要重新
 * 加载一遍，面板越用越慢还找不到原因。
 *
 * 清理最怕的是误删：日期解析不出来的键一律不动，宁可留着垃圾也不能删掉真设置。
 */
function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-ephemeral-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      const settings = await import(url("server/repositories/settingsRepository.ts"));

      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const query = (sql, params = []) => runtime.queryRaw(sql, params);
      const dayString = (offsetDays) =>
        new Date(Date.now() - offsetDays * 24 * 3600 * 1000).toISOString().slice(0, 10);

      ${body}

      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "settings.db") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("过期的日标记会被清掉，今天的留着", () => {
  runInDatabase(String.raw`
    await settings.setSetting("emailReminder:expiry:7:42:" + dayString(30), "sent");
    await settings.setSetting("telegramReminder:traffic:42:" + dayString(9), "sent");
    await settings.setSetting("autoRenew:7:" + dayString(8), "tried");
    // 今天的还在去重窗口里，删了就会重复发一次。
    await settings.setSetting("emailReminder:expiry:3:42:" + dayString(0), "sent");

    const pruned = await settings.pruneEphemeralSettings(7);
    assert.equal(pruned, 3);
    // 只数日标记：建表时本来就会写入一批默认设置，它们不该被算进来（也不该被删）。
    const left = (await query("SELECT key FROM system_settings"))
      .map((row) => String(row.key))
      .filter((key) => settings.isEphemeralSettingKey(key));
    assert.deepEqual(left, ["emailReminder:expiry:3:42:" + dayString(0)]);
  `);
});

test("真设置一根汗毛都不能动", () => {
  runInDatabase(String.raw`
    await settings.setSetting("panelPublicUrl", "https://panel.example.com");
    await settings.setSetting("storeEnabled", "true");
    // 名字里带日期、但不是日标记前缀的键，也不该被碰。
    await settings.setSetting("someBackupAt:2020-01-01", "keep me");
    await settings.setSetting("emailReminder:expiry:7:1:" + dayString(30), "sent");

    assert.equal(await settings.pruneEphemeralSettings(7), 1);
    assert.equal(await settings.getSetting("panelPublicUrl"), "https://panel.example.com");
    assert.equal(await settings.getSetting("storeEnabled"), "true");
    assert.equal(await settings.getSetting("someBackupAt:2020-01-01"), "keep me");
  `);
});

test("日期解析不出来的日标记宁可留着 —— 不猜", () => {
  runInDatabase(String.raw`
    await settings.setSetting("emailReminder:traffic:42", "sent");
    assert.equal(await settings.pruneEphemeralSettings(7), 0);
    assert.equal(await settings.getSetting("emailReminder:traffic:42"), "sent");
  `);
});

test("日标记不进 getAllSettings —— 那份映射每几秒就要重建一次", () => {
  runInDatabase(String.raw`
    await settings.setSetting("panelPublicUrl", "https://panel.example.com");
    await settings.setSetting("emailReminder:expiry:7:42:" + dayString(0), "sent");

    const all = await settings.getAllSettings();
    assert.equal(all.panelPublicUrl, "https://panel.example.com");
    assert.ok(!("emailReminder:expiry:7:42:" + dayString(0) in all), "日标记不该混进设置表");
    // 但按精确键仍然读得到 —— 去重逻辑靠的就是这条路。
    assert.equal(await settings.getSetting("emailReminder:expiry:7:42:" + dayString(0)), "sent");
  `);
});
