import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_TUNNEL_PATHS } from "./agentEncryptionMiddleware";
import { createSupportBundleTask, getSupportBundleTask, redactConfigAuditEventForSupport, redactSupportValue } from "./supportBundle";

test("Agent support and migration reports are accepted through the encrypted sync tunnel", () => {
  assert.equal(AGENT_TUNNEL_PATHS.has("/api/agent/support-bundle-result"), true);
  assert.equal(AGENT_TUNNEL_PATHS.has("/api/agent/migration-rollback"), true);
});

test("support bundle redaction removes nested credentials", () => {
  const value = redactSupportValue({ token: "abc", nested: { password: "def", message: "token=ghi" } });
  assert.deepEqual(value, { token: "[REDACTED]", nested: { password: "[REDACTED]", message: "token=[REDACTED]" } });
});

test("support bundle completes immediately for offline Agents", async () => {
  const task = createSupportBundleTask([{ id: 9, name: "offline", isOnline: false, agentToken: "hidden" }]);
  const status = await getSupportBundleTask(task.taskId);
  assert.equal(status?.complete, true);
  assert.equal(status?.hosts[0]?.status, "offline");
  assert.ok(status?.download?.content.includes("forwardx-support-bundle-v1"));
  assert.ok(!status?.download?.content.includes("hidden"));
});

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecretbody\n-----END RSA PRIVATE KEY-----";

test("support bundle redaction removes TLS private keys by field name and by PEM content", () => {
  const value = redactSupportValue({
    certKeyPem: PEM,
    keyPem: PEM,
    privkey: PEM,
    certPem: "-----BEGIN CERTIFICATE-----\nMIIBpublic\n-----END CERTIFICATE-----",
    log: `nginx reload ok\n${PEM}\ndone`,
    truncated: "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIpartial",
  });
  assert.equal(value.certKeyPem, "[REDACTED]");
  assert.equal(value.keyPem, "[REDACTED]");
  assert.equal(value.privkey, "[REDACTED]");
  // 证书本身是公开信息，保留便于排查。
  assert.match(value.certPem, /MIIBpublic/);
  assert.equal(value.log, "nginx reload ok\n-----BEGIN RSA PRIVATE KEY-----[REDACTED]-----END RSA PRIVATE KEY-----\ndone");
  assert.doesNotMatch(value.truncated, /MHcCAQEEIpartial/);
});

test("already stored audit rows are re-redacted when exported in a support bundle", () => {
  // 模拟升级前按旧规则入库、certKeyPem 原样保存的审计行。
  const row = {
    id: 5,
    resourceType: "tunnel",
    afterJson: JSON.stringify({ id: 1, name: "nginx", certKeyPem: PEM }),
    beforeJson: "not-json " + PEM,
    diffJson: JSON.stringify({ certKeyPem: { before: null, after: PEM } }),
  };
  const redacted = redactConfigAuditEventForSupport(row);
  const serialized = JSON.stringify(redacted);
  assert.doesNotMatch(serialized, /MIIEowIBAAKCAQEAsecretbody/);
  assert.deepEqual(JSON.parse(redacted.afterJson), { id: 1, name: "nginx", certKeyPem: "[REDACTED]" });
  assert.deepEqual(JSON.parse(redacted.diffJson), { certKeyPem: "[REDACTED]" });
  assert.equal(redacted.id, 5);
});
