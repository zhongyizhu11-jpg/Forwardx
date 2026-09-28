import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function runIsolatedScript(directory: string, databasePath: string, name: string, script: string) {
  const scriptPath = path.join(directory, `${name}.mjs`);
  fs.writeFileSync(scriptPath, script, "utf8");
  const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_TYPE: "sqlite",
      FORWARDX_TEST_DB: databasePath,
      FORWARDX_LOG_DIR: path.join(directory, "logs"),
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.error?.stack || result.stderr || result.stdout);
}

test("DDNS defaults to a 60s TTL and clamps to the provider free-tier minimum instead of failing", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-ddns-ttl-"));
  const databasePath = path.join(directory, "ddns-ttl.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const settings = await import(moduleUrl("server/repositories/settingsRepository.ts"));
      const ddns = await import(moduleUrl("server/ddns.ts"));

      // Fresh panel: the seeded TTL is 60s, not 600s.
      assert.equal(ddns.DEFAULT_DDNS_TTL, 60);
      assert.equal((await ddns.getDdnsSettings()).ttl, 60);

      // --- Cloudflare accepts 60s: no clamping.
      await settings.setSettings({
        ddnsEnabled: "true",
        ddnsProvider: "cloudflare",
        ddnsCloudflareZoneId: "zone-1",
        ddnsCloudflareApiToken: "token-1",
      });
      const cloudflareTtls = [];
      globalThis.fetch = async (rawUrl, init = {}) => {
        const method = String(init.method || "GET").toUpperCase();
        if (method === "GET") return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
        const payload = JSON.parse(String(init.body || "{}"));
        cloudflareTtls.push(payload.ttl);
        return new Response(JSON.stringify({ success: true, result: payload }), { status: 200 });
      };
      await ddns.updateDdnsRecordValues({ groupId: 1, domain: "edge.cf.test", recordType: "A", values: ["198.51.100.1"] });
      assert.deepEqual(cloudflareTtls, [60]);

      // --- Aliyun free edition rejects TTL < 600: retry at 600 and remember it.
      await settings.setSettings({
        ddnsProvider: "aliyun",
        ddnsAliyunAccessKeyId: "ak",
        ddnsAliyunAccessKeySecret: "sk",
        ddnsAliyunDomainName: "example.com",
      });
      let aliyunRecords = [];
      const aliyunWrites = [];
      globalThis.fetch = async (rawUrl) => {
        const params = new URL(String(rawUrl)).searchParams;
        const action = params.get("Action");
        if (action === "DescribeSubDomainRecords") {
          return new Response(JSON.stringify({ DomainRecords: { Record: aliyunRecords } }), { status: 200 });
        }
        const ttl = Number(params.get("TTL"));
        aliyunWrites.push({ action, ttl });
        if (ttl < 600) {
          return new Response(JSON.stringify({
            Code: "QuotaExceeded.TTL",
            Message: "The TTL has exceeded the limit of the domain edition.",
          }), { status: 400 });
        }
        if (action === "AddDomainRecord") {
          aliyunRecords = [{ RecordId: "r1", RR: params.get("RR"), Type: params.get("Type"), Value: params.get("Value"), Line: params.get("Line"), TTL: ttl }];
        }
        return new Response(JSON.stringify({ RecordId: "r1" }), { status: 200 });
      };
      await ddns.updateDdnsRecordValues({ groupId: 2, domain: "edge.example.com", recordType: "A", values: ["198.51.100.2"] });
      assert.deepEqual(aliyunWrites, [
        { action: "AddDomainRecord", ttl: 60 },
        { action: "AddDomainRecord", ttl: 600 },
      ]);
      aliyunWrites.length = 0;
      await ddns.updateDdnsRecordValues({ groupId: 2, domain: "edge.example.com", recordType: "A", values: ["198.51.100.3"] });
      assert.deepEqual(aliyunWrites, [{ action: "UpdateDomainRecord", ttl: 600 }], "learned minimum must be reused");

      // Non-TTL errors are still surfaced, not retried.
      ddns.resetDdnsProviderMinTtlCacheForTests();
      aliyunWrites.length = 0;
      globalThis.fetch = async (rawUrl) => {
        const params = new URL(String(rawUrl)).searchParams;
        if (params.get("Action") === "DescribeSubDomainRecords") {
          return new Response(JSON.stringify({ DomainRecords: { Record: [] } }), { status: 200 });
        }
        aliyunWrites.push(params.get("Action"));
        return new Response(JSON.stringify({ Code: "InvalidAccessKeyId.NotFound", Message: "Specified access key is not found." }), { status: 404 });
      };
      await assert.rejects(
        ddns.updateDdnsRecordValues({ groupId: 2, domain: "edge.example.com", recordType: "A", values: ["198.51.100.4"] }),
        /access key/,
      );
      assert.deepEqual(aliyunWrites, ["AddDomainRecord"]);

      // --- Tencent DNSPod free plan: same clamp.
      await settings.setSettings({
        ddnsProvider: "tencentcloud",
        ddnsTencentCloudSecretId: "id",
        ddnsTencentCloudSecretKey: "key",
        ddnsTencentCloudDomainName: "example.net",
      });
      const tencentWrites = [];
      globalThis.fetch = async (rawUrl, init = {}) => {
        const action = String(init.headers?.["X-TC-Action"] || "");
        const payload = JSON.parse(String(init.body || "{}"));
        if (action === "DescribeRecordList") {
          return new Response(JSON.stringify({ Response: { RecordList: [] } }), { status: 200 });
        }
        tencentWrites.push({ action, ttl: payload.TTL });
        if (payload.TTL < 600) {
          return new Response(JSON.stringify({
            Response: { Error: { Code: "LimitExceeded.RecordTtlLimit", Message: "记录的TTL值超出了限制。" } },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ Response: { RecordId: 1 } }), { status: 200 });
      };
      await ddns.updateDdnsRecord({ groupId: 3, domain: "edge.example.net", recordType: "A", value: "198.51.100.5" });
      assert.deepEqual(tencentWrites, [
        { action: "CreateRecord", ttl: 60 },
        { action: "CreateRecord", ttl: 600 },
      ]);

      // A TTL explicitly above the floor is submitted unchanged.
      ddns.resetDdnsProviderMinTtlCacheForTests();
      tencentWrites.length = 0;
      await ddns.updateDdnsRecordValues({ groupId: 3, domain: "edge.example.net", recordType: "A", values: ["198.51.100.6"], ttl: 1200 });
      assert.deepEqual(tencentWrites, [{ action: "CreateRecord", ttl: 1200 }]);
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;

  try {
    runIsolatedScript(directory, databasePath, "ddns-ttl", script);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
