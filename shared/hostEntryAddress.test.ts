import assert from "node:assert/strict";
import test from "node:test";

import {
  formatHostAddressWithPort,
  getEntryAddressFamily,
  getHostEntryAddress,
  getHostEntryAddresses,
} from "./hostEntryAddress";

test("自定义域名优先于 DDNS 与自动探测的 IP", () => {
  const host = {
    ip: "1.2.3.4",
    ipv4: "1.2.3.4",
    entryIp: "gz1.example.com",
    ddnsEnabled: true,
    ddnsDomain: "ddns.example.com",
  };

  assert.equal(getHostEntryAddress(host), "gz1.example.com");
  assert.deepEqual(getHostEntryAddresses(host), [
    { label: "自定义", value: "gz1.example.com" },
    { label: "DDNS", value: "ddns.example.com" },
  ]);
});

test("自定义地址是 IP 时排在 DDNS 域名之后", () => {
  // 域名在主机换 IP 后仍然有效，所以域名优先。
  const host = { ip: "1.2.3.4", entryIp: "5.6.7.8", ddnsEnabled: true, ddnsDomain: "ddns.example.com" };

  assert.deepEqual(getHostEntryAddresses(host), [
    { label: "DDNS", value: "ddns.example.com" },
    { label: "入口", value: "5.6.7.8" },
  ]);
});

test("没有自定义和 DDNS 时回退到自动探测的地址", () => {
  assert.equal(getHostEntryAddress({ ip: "1.2.3.4" }), "1.2.3.4");
  assert.equal(getHostEntryAddress({ ip: "2001:db8::1" }), "2001:db8::1");
  assert.equal(getHostEntryAddress({ ip: "1.2.3.4", ipv4: "9.9.9.9" }), "9.9.9.9");
});

test("ddnsEnabled 为 false 时忽略已填的 DDNS 域名", () => {
  const host = { ip: "1.2.3.4", ddnsEnabled: false, ddnsDomain: "ddns.example.com" };

  assert.equal(getHostEntryAddress(host), "1.2.3.4");
});

test("IPv6 会追加在列表末尾且不重复", () => {
  const host = { ip: "1.2.3.4", ipv4: "1.2.3.4", ipv6: "2001:db8::1" };

  assert.deepEqual(getHostEntryAddresses(host), [
    { label: "IPv4", value: "1.2.3.4" },
    { label: "IPv6", value: "2001:db8::1" },
  ]);
  assert.deepEqual(getHostEntryAddresses({ ip: "2001:db8::1", ipv6: "2001:db8::1" }), [
    { label: "IPv6", value: "2001:db8::1" },
  ]);
});

test("没有任何可用地址时返回空", () => {
  assert.equal(getHostEntryAddress(null), "");
  assert.equal(getHostEntryAddress({}), "");
  assert.deepEqual(getHostEntryAddresses(undefined), []);
});

test("拼接端口时给 IPv6 字面量补方括号", () => {
  assert.equal(formatHostAddressWithPort("1.2.3.4", 20001), "1.2.3.4:20001");
  assert.equal(formatHostAddressWithPort("2001:db8::1", 20001), "[2001:db8::1]:20001");
  assert.equal(formatHostAddressWithPort("[2001:db8::1]", 20001), "[2001:db8::1]:20001");
  assert.equal(formatHostAddressWithPort("", 20001), "");
});

test("地址族判定区分 IPv4、IPv6 和域名", () => {
  assert.equal(getEntryAddressFamily("1.2.3.4"), "ipv4");
  assert.equal(getEntryAddressFamily("2001:db8::1"), "ipv6");
  assert.equal(getEntryAddressFamily("[2001:db8::1]"), "ipv6");
  assert.equal(getEntryAddressFamily("gz1.example.com"), "hostname");
  assert.equal(getEntryAddressFamily("999.1.1.1"), "hostname");
  assert.equal(getEntryAddressFamily(""), "unknown");
});
