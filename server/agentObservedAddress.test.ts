import assert from "node:assert/strict";
import test from "node:test";
import { mergeAgentReportedAddress, observedAgentAddress } from "./agentAddressState";
import { agentPrivateIpv4, noteAgentPrivateIpv4 } from "./agentPrivateAddress";

/*
  有些机器上 Agent 连不上 ipify 这类服务，一个地址都报不上来，「Agent 检测 IP」
  是「-」，地区也查不了。面板看到的连接地址就是它的出口 IP，拿来补上。
*/

const request = (remoteAddress: string, options: { ip?: string; headers?: Record<string, string> } = {}) => ({
  ip: options.ip ?? remoteAddress,
  socket: { remoteAddress },
  headers: options.headers || {},
});

test("observedAgentAddress：直连的公网对端地址可用，IPv4-mapped 拆开", () => {
  assert.equal(observedAgentAddress(request("45.76.10.2")), "45.76.10.2");
  assert.equal(observedAgentAddress(request("::ffff:45.32.1.9")), "45.32.1.9");
  assert.equal(observedAgentAddress(request("2a01:4f8::1")), "2a01:4f8::1");
});

test("observedAgentAddress：内网、环回、代理没被信任、Cloudflare 的都不认", () => {
  assert.equal(observedAgentAddress(request("10.0.0.8")), "");
  assert.equal(observedAgentAddress(request("127.0.0.1")), "");
  assert.equal(observedAgentAddress(request("::ffff:127.0.0.1")), "");
  // 前面有反代但没配 trust proxy：req.ip 就是代理本身，带着转发头
  assert.equal(observedAgentAddress(request("45.32.1.9", { headers: { "x-forwarded-for": "8.8.8.8" } })), "");
  // 配了 trust proxy：req.ip 被解析成真实客户端
  assert.equal(observedAgentAddress(request("127.0.0.1", { ip: "45.32.1.9", headers: { "x-forwarded-for": "45.32.1.9" } })), "45.32.1.9");
  assert.equal(observedAgentAddress(request("104.16.1.1", { ip: "45.32.1.9", headers: { "cf-ray": "abc", "x-forwarded-for": "45.32.1.9" } })), "");
});

test("mergeAgentReportedAddress：Agent 没报地址时用面板看到的地址补上", () => {
  assert.deepEqual(
    mergeAgentReportedAddress({ ip: "unknown", ipv4: "", ipv6: "" }, { ip: "unknown", ipv4: null, ipv6: null }, "45.32.1.9"),
    { ip: "45.32.1.9", ipv4: "45.32.1.9", ipv6: null },
  );
  assert.deepEqual(
    mergeAgentReportedAddress({ ip: "unknown" }, undefined, "2a01:4f8::1"),
    { ip: "2a01:4f8::1", ipv4: null, ipv6: "2a01:4f8::1" },
  );
});

test("mergeAgentReportedAddress：Agent 报的、库里已有的都比连接地址优先", () => {
  assert.deepEqual(
    mergeAgentReportedAddress({ ip: "1.2.3.4", ipv4: "1.2.3.4" }, undefined, "45.32.1.9"),
    { ip: "1.2.3.4", ipv4: "1.2.3.4", ipv6: null },
  );
  assert.deepEqual(
    mergeAgentReportedAddress({}, { ip: "5.6.7.8", ipv4: "5.6.7.8", ipv6: null }, "45.32.1.9"),
    { ip: "5.6.7.8", ipv4: "5.6.7.8", ipv6: null },
  );
});

test("Agent 上报的内网 IPv4：只收内网地址", () => {
  noteAgentPrivateIpv4(9001, "10.0.0.8");
  assert.equal(agentPrivateIpv4(9001), "10.0.0.8");
  noteAgentPrivateIpv4(9002, "8.8.8.8");
  noteAgentPrivateIpv4(9003, "127.0.0.1");
  noteAgentPrivateIpv4(9004, "10.0.0.8; rm -rf /");
  assert.equal(agentPrivateIpv4(9002), null);
  assert.equal(agentPrivateIpv4(9003), null);
  assert.equal(agentPrivateIpv4(9004), null);
  noteAgentPrivateIpv4(9001, "");
  assert.equal(agentPrivateIpv4(9001), "10.0.0.8", "这次没报不清掉上次的");
});
