import assert from "node:assert/strict";
import test from "node:test";

import {
  createEmptyProxyInbound,
  validateProxyInbound,
  PROXY_INBOUND_SHADOWSOCKS_METHODS,
  proxyInboundShadowsocksKeyBytes,
} from "../shared/proxyInbound";
import {
  generateProxyInboundPassword,
  generateProxyInboundPsk,
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

test("SS2022 的 PSK 长度按算法生成，老 AEAD 用普通口令", () => {
  /**
   * 两类算法的密码规则不一样，这是这里最容易踩的坑：
   *   SS2022   定长密钥。长度不对 sing-box 报 `bad key` 并拒绝加载**整份**配置，
   *            同一台落地机上其他入站会跟着一起停，而报错跟「刚换了加密方式」
   *            看不出关联。
   *   老 AEAD  任意口令，多长都收（拿 1.14.0 实测 7 / 24 / 44 字符都能过 check）。
   */
  for (const method of PROXY_INBOUND_SHADOWSOCKS_METHODS) {
    const bytes = proxyInboundShadowsocksKeyBytes(method);
    const password = bytes > 0 ? generateProxyInboundPsk(bytes) : generateProxyInboundPassword();
    if (bytes > 0) {
      assert.equal(Buffer.from(password, "base64").length, bytes, `${method} 的 PSK 应为 ${bytes} 字节`);
    } else {
      // 老 AEAD 没有长度要求，只要不是空的。
      assert.ok(password.length > 0, `${method} 应当给出一个口令`);
    }

    const reason = validateProxyInbound({
      ...createEmptyProxyInbound(),
      protocol: "shadowsocks",
      port: 8388,
      security: "none",
      method,
      password,
    });
    assert.equal(reason, "", `${method} 应当通过校验，实际: ${reason}`);
  }
});

test("只有 SS2022 那三种要定长密钥", () => {
  // 给老 AEAD 按长度生成密码是没有意义的 —— 它那个字段是口令不是密钥。
  assert.equal(proxyInboundShadowsocksKeyBytes("2022-blake3-aes-128-gcm"), 16);
  assert.equal(proxyInboundShadowsocksKeyBytes("2022-blake3-aes-256-gcm"), 32);
  assert.equal(proxyInboundShadowsocksKeyBytes("2022-blake3-chacha20-poly1305"), 32);
  assert.equal(proxyInboundShadowsocksKeyBytes("aes-128-gcm"), 0);
  assert.equal(proxyInboundShadowsocksKeyBytes("aes-256-gcm"), 0);
});

test("认不出来的加密方式当场被拦住，不会走到落地机上", () => {
  /**
   * 拼错的、或者我们没放出来的算法（chacha20-ietf-poly1305 这些）都要挡在保存之前。
   * 放过去的话 sing-box 会拒绝加载整份配置，而报错跟「刚改了加密方式」毫无字面关联。
   */
  for (const method of ["chacha20-ietf-poly1305", "aes-192-gcm", "rc4-md5", "乱填的"]) {
    const reason = validateProxyInbound({
      ...createEmptyProxyInbound(),
      protocol: "shadowsocks",
      port: 8388,
      security: "none",
      method,
      password: generateProxyInboundPassword(),
    });
    assert.match(reason, /不支持的加密方式/, `${method} 应当被拒绝`);
  }
});
