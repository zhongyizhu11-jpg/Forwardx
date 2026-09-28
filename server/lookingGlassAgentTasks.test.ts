import assert from "node:assert/strict";
import test from "node:test";
import {
  capLookingGlassOutput,
  completeLookingGlassAgentTask,
  enqueueLookingGlassAgentTask,
  LOOKING_GLASS_OUTPUT_MAX_BYTES,
  getLookingGlassAgentTaskStatus,
  pruneLookingGlassAgentTaskStates,
  takeLookingGlassAgentTasks,
} from "./lookingGlassAgentTasks";

test("timed-out Looking Glass tasks leave the queue and are eventually removed", async () => {
  const hostId = 987654;
  const { task } = enqueueLookingGlassAgentTask(hostId, {
    method: "ping",
    target: "example.com",
    resolvedAddress: "192.0.2.1",
    resolvedAddresses: ["192.0.2.1"],
    family: 4,
  }, 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const status = getLookingGlassAgentTaskStatus(hostId, task.taskId);
  assert.equal(status?.status, "timeout");
  assert.deepEqual(takeLookingGlassAgentTasks(hostId), []);

  const updatedAt = new Date(status!.updatedAt).getTime();
  assert.equal(pruneLookingGlassAgentTaskStates(updatedAt + 16 * 60 * 1000), 1);
  assert.equal(getLookingGlassAgentTaskStatus(hostId, task.taskId), null);
});

test("Looking Glass output reported by an Agent is capped before it is kept", () => {
  assert.equal(capLookingGlassOutput("short"), "short");
  const huge = "a".repeat(LOOKING_GLASS_OUTPUT_MAX_BYTES * 4);
  const capped = capLookingGlassOutput(huge);
  assert.ok(Buffer.byteLength(capped, "utf8") < LOOKING_GLASS_OUTPUT_MAX_BYTES + 256);
  assert.match(capped, /已截断/);
  // 多字节字符被截在中间时不能留下半个字符。
  assert.doesNotMatch(capLookingGlassOutput("中".repeat(LOOKING_GLASS_OUTPUT_MAX_BYTES)), /\uFFFD/);

  const hostId = 987655;
  const { task } = enqueueLookingGlassAgentTask(hostId, {
    method: "ping",
    target: "example.com",
    resolvedAddress: "192.0.2.1",
    resolvedAddresses: ["192.0.2.1"],
    family: 4,
  }, 60_000);
  takeLookingGlassAgentTasks(hostId);
  assert.equal(completeLookingGlassAgentTask(hostId, { taskId: task.taskId, output: huge, exitCode: 0 } as any), true);
  const status = getLookingGlassAgentTaskStatus(hostId, task.taskId);
  assert.ok(Buffer.byteLength(String(status?.output || ""), "utf8") < LOOKING_GLASS_OUTPUT_MAX_BYTES + 256);
});
