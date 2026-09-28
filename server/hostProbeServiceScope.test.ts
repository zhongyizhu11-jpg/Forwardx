import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("host probe services with all/exclude scope never run on tenant-owned hosts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-probe-scope-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const probes = await import(moduleUrl("server/repositories/hostProbeServiceRepository.ts"));

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw('INSERT INTO "users" ("id", "username", "password", "name", "role") VALUES (?, ?, ?, ?, ?)', [1, "admin", "h", "Admin", "admin"]);
      await runtime.executeRaw('INSERT INTO "users" ("id", "username", "password", "name", "role") VALUES (?, ?, ?, ?, ?)', [2, "tenant", "h", "Tenant", "user"]);
      await runtime.executeRaw('INSERT INTO "hosts" ("id", "name", "ip", "hostType", "agentToken", "userId") VALUES (?, ?, ?, ?, ?, ?)', [10, "admin-host", "10.0.0.10", "slave", "t10", 1]);
      await runtime.executeRaw('INSERT INTO "hosts" ("id", "name", "ip", "hostType", "agentToken", "userId") VALUES (?, ?, ?, ?, ?, ?)', [20, "tenant-host", "10.0.0.20", "slave", "t20", 2]);

      await probes.createHostProbeService({ name: "all", method: "ping", targetIp: "1.1.1.1", hostScope: "all", userId: 1 });
      await probes.createHostProbeService({ name: "exclude", method: "ping", targetIp: "8.8.8.8", hostScope: "exclude", excludeHostIds: [99], userId: 1 });
      await probes.createHostProbeService({ name: "specific", method: "ping", targetIp: "9.9.9.9", hostScope: "specific", hostIds: [20], userId: 1 });

      const targets = async (hostId) => (await probes.getHostProbeTasksForHost(hostId)).map((task) => task.targetIp).sort();
      assert.deepEqual(await targets(10), ["1.1.1.1", "8.8.8.8"]);
      // 租户主机只跑管理员点名给它的服务。
      assert.deepEqual(await targets(20), ["9.9.9.9"]);
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "probe.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
      encoding: "utf8",
      timeout: 90_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
