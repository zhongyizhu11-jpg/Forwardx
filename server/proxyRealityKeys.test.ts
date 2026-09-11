import assert from "node:assert/strict";
import test from "node:test";

import { validateProxyInbound, createEmptyProxyInbound } from "../shared/proxyInbound";
import {
  generateProxyInboundPassword,
  generateProxyInboundUuid,
  generateRealityKeyPair,
  generateRealityShortId,
} from "./proxyRealityKeys";

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

test("REALITY 密钥对是 32 字节的 X25519 裸密钥，base64url 不带补位", () => {
  const { privateKey, publicKey } = generateRealityKeyPair();

  // 格式要和 `sing-box generate reality-keypair` 一致，否则落地机会拒绝配置。
  assert.equal(decodeBase64Url(privateKey).length, 32);
  assert.equal(decodeBase64Url(publicKey).length, 32);
  for (const key of [privateKey, publicKey]) {
    assert.doesNotMatch(key, /[+/=]/, key);
    assert.match(key, /^[A-Za-z0-9_-]{43}$/, key);
  }
});

test("每次生成的密钥对都不一样，公私钥也不相等", () => {
  const first = generateRealityKeyPair();
  const second = generateRealityKeyPair();
  assert.notEqual(first.privateKey, second.privateKey);
  assert.notEqual(first.publicKey, second.publicKey);
  assert.notEqual(first.privateKey, first.publicKey);
});

test("short-id 是 4 字节十六进制，落在协议允许的区间里", () => {
  for (let i = 0; i < 20; i += 1) {
    assert.match(generateRealityShortId(), /^[0-9a-f]{8}$/);
  }
});

test("生成出来的凭据能直接通过入站校验", () => {
  // 这条守的是「生成」和「校验」两侧不要各说各话 —— 生成器换了格式而校验没跟上，
  // 表现会是新建节点时报一个看不懂的错。
  const pair = generateRealityKeyPair();
  const reason = validateProxyInbound({
    ...createEmptyProxyInbound(),
    protocol: "vless",
    port: 443,
    security: "reality",
    // VLESS 的凭据在 users 上 —— 入站行上的 uuid 不再参与鉴权。
    users: [{ id: 1, name: "默认", uuid: generateProxyInboundUuid(), password: "" }],
    serverName: "dl.google.com",
    realityPrivateKey: pair.privateKey,
    realityPublicKey: pair.publicKey,
    realityShortId: generateRealityShortId(),
  });
  assert.equal(reason, "");
});

test("随机密码与 UUID 的形状正确", () => {
  assert.match(generateProxyInboundPassword(), /^[A-Za-z0-9_-]{22}$/);
  assert.match(generateProxyInboundUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(generateProxyInboundPassword(), generateProxyInboundPassword());
});
