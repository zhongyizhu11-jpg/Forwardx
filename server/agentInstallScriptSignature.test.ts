import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { signAgentInstallScript } from "./agentInstallScriptSignature";

test("install script signature matches the Go agent vector", () => {
  // 和 agent/upgrade_test.go 用同一组向量，两端算法变了任何一边都会失败。
  assert.equal(
    signAgentInstallScript("vector-token", "#!/bin/bash\necho forwardx\n"),
    "v1.522a96b8b68fbe851a7f4310ae42d2b5e64447820c6dc6d15b91bc26a5804d6d",
  );
  assert.notEqual(
    signAgentInstallScript("vector-token", "#!/bin/bash\necho pwned\n"),
    signAgentInstallScript("vector-token", "#!/bin/bash\necho forwardx\n"),
  );
});

test("install script is signed only for requests with a verified Agent auth proof", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-install-signature-"));
  const databasePath = path.join(directory, "install-signature.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import crypto from "node:crypto";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const agentCrypto = await import(url("server/agentCrypto.ts"));
    const signature = await import(url("server/agentInstallScriptSignature.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    await runtime.executeRaw(
      'INSERT INTO "users" ("id", "username", "password", "name", "role", "trafficUsed") VALUES (?, ?, ?, ?, ?, ?)',
      [1, "admin", "hash", "Admin", "admin", 0],
    );
    const token = "install-signature-host-token";
    await runtime.executeRaw(
      'INSERT INTO "hosts" ("id", "name", "ip", "hostType", "agentToken", "userId") VALUES (?, ?, ?, ?, ?, ?)',
      [1, "host", "127.0.0.2", "slave", token, 1],
    );

    const body = "#!/bin/bash\necho install\n";
    const request = (authorization) => ({
      method: "GET",
      baseUrl: "",
      path: "/api/agent/install.sh",
      headers: authorization ? { authorization } : {},
    });
    const proofFor = (tokenValue, requestPath = "/api/agent/install.sh") => {
      const ts = Date.now();
      const nonce = crypto.randomBytes(16).toString("hex");
      const sig = agentCrypto.signAgentAuthProof({ token: tokenValue, method: "GET", path: requestPath, bodyText: "", ts, nonce });
      return "Bearer v1." + agentCrypto.agentTokenFingerprint(tokenValue) + "." + ts + "." + nonce + "." + sig;
    };

    assert.equal(await signature.installScriptSignatureForRequest(request(""), body), null, "anonymous installs get no signature");
    assert.equal(await signature.installScriptSignatureForRequest(request("Bearer " + token), body), null, "raw bearer tokens are not a signed proof");
    assert.equal(await signature.installScriptSignatureForRequest(request(proofFor("unknown-token")), body), null);
    assert.equal(await signature.installScriptSignatureForRequest(request(proofFor(token, "/api/agent/heartbeat")), body), null, "a proof for another path is rejected");
    assert.equal(
      await signature.installScriptSignatureForRequest(request(proofFor(token)), body),
      signature.signAgentInstallScript(token, body),
    );
    await runtime.closeDatabase();
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
      timeout: 90_000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
