import assert from "node:assert/strict";
import test from "node:test";
import { AgentActionIssueTracker, AgentStatusOrderGuard, normalizeAgentStatusIssuedAt } from "./agentStatusOrdering";

test("Agent status ordering accepts equal/new epochs and rejects older results", () => {
  const guard = new AgentStatusOrderGuard();
  const now = 2_000_000;
  assert.equal(guard.accept("host:1:rule:7", 100, now), true);
  assert.equal(guard.accept("host:1:rule:7", 200, now), true);
  assert.equal(guard.accept("host:1:rule:7", 100, now), false);
  assert.equal(guard.accept("host:1:rule:7", 200, now), true);
  assert.equal(guard.accept("host:2:rule:7", 100, now), true);
});

test("Agent status ordering rejects an old ACK after a newer action is dispatched", () => {
  const guard = new AgentStatusOrderGuard();
  const now = 2_000_000;
  guard.expect("host:1:rule:9", 300, now);
  assert.equal(guard.accept("host:1:rule:9", 200, now), false);
  assert.equal(guard.accept("host:1:rule:9", 300, now), true);
});

test("Agent status ordering keeps legacy and invalid timestamps compatible", () => {
  const guard = new AgentStatusOrderGuard();
  const now = 2_000_000;
  assert.equal(guard.accept("host:1:rule:8", undefined, now), true);
  assert.equal(guard.accept("host:1:rule:8", 100, now), true);
  assert.equal(guard.accept("host:1:rule:8", now + 10 * 60 * 1000, now), true);
  assert.equal(normalizeAgentStatusIssuedAt(now + 10 * 60 * 1000, now), 0);
});

/**
 * 生产里看到的：桥接的 apply 在 Agent 报回结果前被下一次心跳原样重发（批次里别的动作变了，
 * 整批 issuedAt 换新），Agent 对第一份的结果被当成过期丢掉。内容没变的重发不该抬高期望。
 */
test("同一条动作内容没变地重发时不抬高期望，Agent 对上一份的结果仍然算数", () => {
  const guard = new AgentStatusOrderGuard();
  const tracker = new AgentActionIssueTracker();
  const key = "agent-status:1:rule:2000000006";
  const now = 2_000_000;
  const issue = (issuedAt: number, signature: string, at: number) => {
    if (tracker.shouldExpect(key, signature, at)) guard.expect(key, issuedAt, at);
  };
  issue(100, "sig-a", now);
  issue(200, "sig-a", now + 2_000);
  assert.equal(guard.accept(key, 100, now + 3_000), true, "第一批的结果不该被当成过期");
  assert.equal(guard.accept(key, 200, now + 4_000), true, "第二批的结果照常接受");
  assert.equal(guard.accept(key, 100, now + 5_000), false, "收过更新的结果之后，旧的才算过期");

  // 内容变了（比如桥接改指了新目标）：期望抬高，旧结果该丢。
  issue(300, "sig-b", now + 6_000);
  assert.equal(guard.accept(key, 200, now + 7_000), false);
  assert.equal(guard.accept(key, 300, now + 7_000), true);

  // 很久没发过再发：按新下发算。
  issue(400, "sig-b", now + 6_000 + 60_000);
  assert.equal(guard.accept(key, 300, now + 6_000 + 61_000), false);
  assert.equal(guard.accept(key, 400, now + 6_000 + 61_000), true);
});

test("动作记录按主机前缀忘掉、按时间清理", () => {
  const tracker = new AgentActionIssueTracker();
  const now = 2_000_000;
  assert.equal(tracker.shouldExpect("agent-status:1:rule:5", "sig", now), true);
  assert.equal(tracker.shouldExpect("agent-status:1:rule:5", "sig", now + 1_000), false);
  tracker.forgetPrefix("agent-status:1:");
  assert.equal(tracker.shouldExpect("agent-status:1:rule:5", "sig", now + 2_000), true);
  tracker.prune(now + 2_000 + 60_000);
  assert.equal(tracker.shouldExpect("agent-status:1:rule:5", "sig", now + 2_000 + 60_000), true);
  assert.equal(tracker.shouldExpect("", "sig", now), true);
  assert.equal(tracker.shouldExpect("agent-status:1:rule:6", "", now), true);
});
