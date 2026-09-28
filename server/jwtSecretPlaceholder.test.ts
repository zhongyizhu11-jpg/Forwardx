import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isPlaceholderJwtSecret, readOrCreateCookieSecret } from "./env";

function tempSecretPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-jwt-secret-"));
  return { directory, secretPath: path.join(directory, "jwt.secret") };
}

test("the shipped JWT_SECRET placeholder is replaced by a generated persistent secret", () => {
  const { directory, secretPath } = tempSecretPath();
  try {
    const env = { JWT_SECRET: "change-me-to-a-random-string", FORWARDX_JWT_SECRET_PATH: secretPath };
    const generated = readOrCreateCookieSecret(env);
    assert.notEqual(generated, "change-me-to-a-random-string");
    assert.match(generated, /^[0-9a-f]{64}$/);
    assert.equal(fs.readFileSync(secretPath, "utf8").trim(), generated);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(secretPath).mode & 0o777, 0o600);
    }
    // 重启后读回同一把密钥，不会每次启动都把所有人踢下线。
    assert.equal(readOrCreateCookieSecret(env), generated);
    assert.equal(readOrCreateCookieSecret({ JWT_SECRET: "", FORWARDX_JWT_SECRET_PATH: secretPath }), generated);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an explicitly configured JWT_SECRET is used unchanged", () => {
  const { directory, secretPath } = tempSecretPath();
  try {
    assert.equal(
      readOrCreateCookieSecret({ JWT_SECRET: "  my-own-long-random-value  ", FORWARDX_JWT_SECRET_PATH: secretPath }),
      "my-own-long-random-value",
    );
    assert.equal(fs.existsSync(secretPath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("obvious placeholder values are recognised case-insensitively", () => {
  for (const value of ["change-me-to-a-random-string", "CHANGE-ME", "changeme", " secret "]) {
    assert.equal(isPlaceholderJwtSecret(value), true, value);
  }
  for (const value of ["", "3f9c0d2b8a7e", "change-me-to-a-random-string-but-longer"]) {
    assert.equal(isPlaceholderJwtSecret(value), false, value);
  }
});
