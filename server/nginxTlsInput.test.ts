import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { buildNginxStreamServerBlock } from "./agentHeartbeatRoute";
import { assertNginxCertificatePair, isValidTlsServerName } from "./nginxTlsInput";

// 仅供测试的自签名证书（CN=edge.example.test），私钥没有任何实际用途。
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBjzCCATWgAwIBAgIUKg/aBoOad/AvD8Hw3QwbAm1/ijMwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRZWRnZS5leGFtcGxlLnRlc3QwIBcNMjYwOTI4MTcyMDQ5WhgP
MjEyNjA5MDQxNzIwNDlaMBwxGjAYBgNVBAMMEWVkZ2UuZXhhbXBsZS50ZXN0MFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE63dzEMu/diDa8FWuVwJv2UbnzcnMlkbh
g8OzfC0OIDVQ53QLXN37JoQ90+nFKAC4PXU8aKM0ZZoae8gUjoycYqNTMFEwHQYD
VR0OBBYEFMVleL3ua4LB1NKCryZoiCmAo6YvMB8GA1UdIwQYMBaAFMVleL3ua4LB
1NKCryZoiCmAo6YvMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIh
ALeeC0KdySj1FRQdqb/2wmAIIMLwklpvDU3oPOVFsOTkAiBzkYW8fSerb+102y4v
9evZXPb8XR8PpOFJ/q4STRKqQQ==
-----END CERTIFICATE-----
`;
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgPyJuZPc4iaiDaJ7+
mOdiXtme8wqoohA8q4AxSPGWIMehRANCAATrd3MQy792INrwVa5XAm/ZRufNycyW
RuGDw7N8LQ4gNVDndAtc3fsmhD3T6cUoALg9dTxoozRlmhp7yBSOjJxi
-----END PRIVATE KEY-----
`;

test("证书域名只收严格的主机名", () => {
  for (const ok of ["edge.example.test", "a.b-c.io", "EXAMPLE.com", "1.2.3.4", "example.com."]) {
    assert.equal(isValidTlsServerName(ok), true, ok);
  }
  for (const bad of ["", "a.com;", "a.com; } http {", "$host", "a.com\nproxy_pass x", "*.a.com", "a..com", "-a.com", "a.com:443", "a b.com", `${"a".repeat(64)}.com`]) {
    assert.equal(isValidTlsServerName(bad), false, JSON.stringify(bad));
  }
});

test("自定义证书必须能解析且私钥与证书配对", () => {
  assert.doesNotThrow(() => assertNginxCertificatePair(TEST_CERT, TEST_KEY));
  assert.throws(() => assertNginxCertificatePair("not a cert", TEST_KEY), /证书无法解析/);
  assert.throws(() => assertNginxCertificatePair(TEST_CERT, "not a key"), /私钥无法解析/);
  const otherKey = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey
    .export({ format: "pem", type: "pkcs8" }).toString();
  assert.throws(() => assertNginxCertificatePair(TEST_CERT, otherKey), /不匹配/);
});

test("存量的非法证书域名不会写进 nginx 配置", () => {
  const block = buildNginxStreamServerBlock({
    name: "tunnel entry 9",
    listenPort: 443,
    proto: "tcp",
    upstream: "fwx_tentry_9_tcp",
    sslClient: { serverName: "evil.test; } server { listen 22" },
  });
  assert.match(block, /proxy_ssl on;/);
  assert.doesNotMatch(block, /proxy_ssl_name|listen 22/);
});
