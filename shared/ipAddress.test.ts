import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { classifyIpAddress, expandIpv6, isPrivateOrReservedAddress, isRestrictedOutboundAddress } from "./ipAddress";

/*
  这套判断原来在三个地方各一份，30 个样本里 13 个三方判定不一致。
  下面头两条钉的就是当时真正能被绕过去的写法。
*/

test("环回换个写法也认得出（原来 SSRF 守卫认不出）", () => {
  // `ip === "::1"` 那种写法只认得第一个；后面几个是同一个地址的等价写法
  for (const loopback of ["::1", "0::1", "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001", "[::1]"]) {
    assert.equal(classifyIpAddress(loopback), "loopback", loopback);
    assert.equal(isPrivateOrReservedAddress(loopback), true, loopback);
    assert.equal(isRestrictedOutboundAddress(loopback), true, loopback);
    assert.equal(isRestrictedOutboundAddress(loopback, { allowPrivate: true }), true, `${loopback} 即使允许内网也不能连回自己`);
  }
});

test("IPv4-mapped 要拆开看里面包的是谁（原来网络测试和归属地都放行）", () => {
  // Linux 上连 ::ffff:10.0.0.1 就是连 10.0.0.1
  assert.equal(classifyIpAddress("::ffff:10.0.0.1"), "private");
  assert.equal(classifyIpAddress("::ffff:127.0.0.1"), "loopback");
  assert.equal(classifyIpAddress("::ffff:8.8.8.8"), "public");
  assert.equal(isPrivateOrReservedAddress("::ffff:10.0.0.1"), true);
  assert.equal(isPrivateOrReservedAddress("::ffff:127.0.0.1"), true);
  // 对外请求一概拒绝这种写法，哪怕里面是公网 —— 正经 URL 不会这么写
  assert.equal(isRestrictedOutboundAddress("::ffff:8.8.8.8"), true);
});

test("常见地址各归各类", () => {
  const 预期: Record<string, string> = {
    "8.8.8.8": "public", "1.1.1.1": "public", "2606:4700:4700::1111": "public",
    "127.0.0.1": "loopback", "127.255.255.254": "loopback",
    "10.0.0.1": "private", "172.16.0.1": "private", "172.31.255.254": "private",
    "192.168.1.1": "private", "100.64.0.1": "private", "fc00::1": "private", "fd12::1": "private",
    "169.254.1.1": "linkLocal", "fe80::1": "linkLocal", "fe80::1%eth0": "linkLocal",
    "224.0.0.1": "multicast", "239.255.255.255": "multicast", "ff02::1": "multicast",
    "0.0.0.0": "reserved", "255.255.255.255": "reserved", "192.0.2.5": "reserved",
    "198.51.100.7": "reserved", "203.0.113.9": "reserved", "192.88.99.1": "reserved",
    "198.18.0.1": "reserved", "2001:db8::1": "reserved", "fec0::1": "reserved", "::": "reserved",
    "172.32.0.1": "public", "172.15.0.1": "public", "100.128.0.1": "public",
    "example.com": "invalid", "": "invalid", "999.1.1.1": "invalid", "gggg::1": "invalid",
  };
  for (const [address, kind] of Object.entries(预期)) {
    assert.equal(classifyIpAddress(address), kind, `${address} 应当是 ${kind}`);
  }
});

test("allowPrivate 只放开内网，不放开环回和保留段", () => {
  assert.equal(isRestrictedOutboundAddress("10.0.0.1"), true);
  assert.equal(isRestrictedOutboundAddress("10.0.0.1", { allowPrivate: true }), false);
  assert.equal(isRestrictedOutboundAddress("fc00::1", { allowPrivate: true }), false);
  // 「允许内网」的本意是让自建服务能连，不是连回自己
  assert.equal(isRestrictedOutboundAddress("127.0.0.1", { allowPrivate: true }), true);
  assert.equal(isRestrictedOutboundAddress("169.254.169.254", { allowPrivate: true }), true, "云元数据地址任何时候都不放");
  assert.equal(isRestrictedOutboundAddress("0.0.0.0", { allowPrivate: true }), true);
});

test("IPv6 展开", () => {
  assert.deepEqual(expandIpv6("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(expandIpv6("2001:db8::1"), [0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(expandIpv6("::ffff:127.0.0.1"), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
  assert.deepEqual(expandIpv6("::127.0.0.1"), [0, 0, 0, 0, 0, 0, 0x7f00, 1]);
  assert.equal(expandIpv6("1::2::3"), null, "两个 :: 是非法的");
  assert.equal(expandIpv6("1:2:3:4:5:6:7"), null, "不足 8 组又没有 :: 是非法的");
  assert.equal(expandIpv6("gggg::1"), null);
});

test("认不出来的一律当成不可用", () => {
  for (const junk of ["", "   ", "example.com", "999.1.1.1", "1.2.3", "::ffff:999.1.1.1"]) {
    assert.equal(isPrivateOrReservedAddress(junk), true, junk);
    assert.equal(isRestrictedOutboundAddress(junk), true, junk);
  }
});

test("没有人再自己写一份地址分类", () => {
  /*
    原来三份各写各的，而且都「看着对」—— 只有并排摆出来才发现 30 个样本里
    13 个判定不一致。这条盯着别再长出第四份。

    找的是分类的特征写法：判 RFC1918 的段、判链路本地、按字符串前缀认 IPv6 ——
    不是找 CIDR 列表（订阅规则里那种是给客户端下发的配置，不是判断逻辑）。
  */
  const 特征 = [
    /a === 172 && b >= 16 && b <= 31/,
    /a === 100 && b >= 64 && b <= 127/,
    /169\s*&&\s*b === 254|a === 169 && b === 254/,
    /startsWith\("fc"\)|startsWith\("fd"\)|startsWith\("fe80/,
    /0xfe00\) === 0xfc00|0xffc0\) === 0xfe80/,
  ];
  const root = path.resolve(import.meta.dirname, "..");
  const 自己 = path.join("shared", "ipAddress.ts");
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.name === "node_modules" || item.name === ".git" || item.name === "dist" || item.name === ".dev") continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(item.name) || /\.test\.tsx?$/.test(item.name)) continue;
      const relative = path.relative(root, full);
      if (relative === 自己) continue;
      const source = fs.readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (特征.some((pattern) => pattern.test(source))) hits.push(relative);
    }
  };
  for (const dir of ["server", "shared", "client/src"]) walk(path.join(root, dir));
  assert.deepEqual(
    hits,
    [],
    `这些文件又自己写了一份地址分类，请改用 shared/ipAddress.ts：\n  ${hits.join("\n  ")}`,
  );
});
