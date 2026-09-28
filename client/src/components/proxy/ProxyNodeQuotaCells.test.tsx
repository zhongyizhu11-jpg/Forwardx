import assert from "node:assert/strict";
import test from "node:test";
import { hostQuotaLine } from "./ProxyNodeQuotaCells";

const GiB = 1024 ** 3;

/*
  主机管理按 1024 进制存额度（填 100 GB 存的是 100 × 1024³）。整机这一行原来用的是节点那套
  1000 进制的写法，同一台机器在主机管理是「100 GB」，到了落地节点就成了「107G」。
*/
test("host quota line uses the same 1024-based units as Hosts", () => {
  const line = hostQuotaLine({
    name: "hk",
    trafficLimit: 100 * GiB,
    measureMode: "both",
    bytesIn: 20 * GiB,
    bytesOut: 5 * GiB,
    reported: true,
  });
  assert.ok(line);
  assert.match(line!, /\/ 100 GB/);
  assert.doesNotMatch(line!, /107/);
});

test("host quota line stays hidden when there is nothing to say", () => {
  assert.equal(hostQuotaLine(null), null);
  assert.equal(hostQuotaLine({ name: "x", trafficLimit: 0, measureMode: "both", bytesIn: 0, bytesOut: 0, reported: false }), null);
});
