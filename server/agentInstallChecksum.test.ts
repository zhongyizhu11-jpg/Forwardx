import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateInstallScript } from "./agentInstallScripts";
import { parseSha256Sums } from "./agentAssets";

/** 从生成的脚本里抠出一个 bash 函数的完整定义。 */
function shellFunction(script: string, name: string) {
  const start = script.indexOf(`${name}() {`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = script.indexOf("\n}\n", start);
  return script.slice(start, end + 3);
}

test("downloaded agent binaries are verified against the release SHA-256", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-install-checksum-"));
  try {
    const good = path.join(directory, "agent");
    fs.writeFileSync(good, "real agent binary");
    const hash = createHash("sha256").update("real agent binary").digest("hex");
    const script = generateInstallScript("https://panel.example", {
      releaseChecksums: { "9.9.9": { "forwardx-agent-linux-amd64": hash } },
    });
    const prelude = [
      "FORWARDX_CURL_CONNECT_TIMEOUT=1",
      shellFunction(script, "is_enabled_value"),
      shellFunction(script, "expected_release_sha256"),
      shellFunction(script, "file_sha256"),
      shellFunction(script, "verify_release_checksum"),
      // 测试里不让它真去连 GitHub。
      "curl() { return 1; }",
    ].join("\n");
    const run = (body: string, env: Record<string, string> = {}) => spawnSync("bash", ["-c", `${prelude}\n${body}`], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

    const ok = run(`verify_release_checksum forwardx-agent-linux-amd64 ${good} 9.9.9 "Go Agent"`);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /校验通过/);

    const tampered = path.join(directory, "tampered");
    fs.writeFileSync(tampered, "evil binary");
    const bad = run(`verify_release_checksum forwardx-agent-linux-amd64 ${tampered} 9.9.9 "Go Agent"`);
    assert.equal(bad.status, 1, "a replaced binary must fail the install");
    assert.equal(fs.existsSync(tampered), false, "the replaced binary must be deleted");

    const unknown = path.join(directory, "unknown");
    fs.writeFileSync(unknown, "x");
    const warn = run(`verify_release_checksum forwardx-agent-linux-amd64 ${unknown} 1.0.0 "Go Agent"`);
    assert.equal(warn.status, 0, "no checksum available: warn and continue by default");
    assert.match(warn.stdout, /跳过校验/);
    const strict = run(`verify_release_checksum forwardx-agent-linux-amd64 ${unknown} 1.0.0 "Go Agent"`, { FORWARDX_REQUIRE_CHECKSUM: "1" });
    assert.equal(strict.status, 1, "FORWARDX_REQUIRE_CHECKSUM=1 must refuse unverifiable binaries");

    assert.equal(spawnSync("bash", ["-n"], { input: script }).status, 0, "the generated script must stay valid bash");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SHA256SUMS parsing keeps only known agent assets", () => {
  const sums = parseSha256Sums([
    `${"a".repeat(64)}  forwardx-agent-linux-amd64`,
    `${"b".repeat(64)} *forwardx-fxp-linux-arm64`,
    `${"c".repeat(64)}  forwardx-panel-v1.tar.gz`,
    "garbage",
  ].join("\n"));
  assert.deepEqual(sums, {
    "forwardx-agent-linux-amd64": "a".repeat(64),
    "forwardx-fxp-linux-arm64": "b".repeat(64),
  });
});
