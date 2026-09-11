import assert from "node:assert/strict";
import test from "node:test";

import {
  createEmptyProxyInbound,
  validateProxyInbound,
  PROXY_INBOUND_SHADOWSOCKS_METHODS,
  PROXY_INBOUND_SHADOWSOCKS_KEY_BYTES,
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

test("每种 Shadowsocks 加密方式生成的 PSK 长度都对得上", () => {
  /**
   * 这条守的是一个会波及整台机器的错误：SS2022 的密码是定长的，长度不对
   * sing-box 拒绝加载**整份**配置（实测报 `initialize inbound[0]: bad key`），
   * 同一台落地机上其他入站会跟着一起停，而报错跟「你刚换了加密方式」看不出关联。
   */
  for (const method of PROXY_INBOUND_SHADOWSOCKS_METHODS) {
    const bytes = PROXY_INBOUND_SHADOWSOCKS_KEY_BYTES[method];
    const psk = generateProxyInboundPsk(bytes);
    assert.equal(Buffer.from(psk, "base64").length, bytes, `${method} 的 PSK 应为 ${bytes} 字节`);

    const reason = validateProxyInbound({
      ...createEmptyProxyInbound(),
      protocol: "shadowsocks",
      port: 8388,
      security: "none",
      method,
      password: psk,
    });
    assert.equal(reason, "", `${method} 应当通过校验，实际: ${reason}`);
  }
});

test("认不出来的加密方式当场被拦住，不会走到落地机上", () => {
  // 老的 AEAD 也算认不出来 —— 这一侧只放 SS2022 那三种。
  for (const method of ["aes-256-gcm", "chacha20-ietf-poly1305", "乱填的"]) {
    const reason = validateProxyInbound({
      ...createEmptyProxyInbound(),
      protocol: "shadowsocks",
      port: 8388,
      security: "none",
      method,
      password: generateProxyInboundPsk(32),
    });
    assert.match(reason, /不支持的加密方式/, `${method} 应当被拒绝`);
  }
});
