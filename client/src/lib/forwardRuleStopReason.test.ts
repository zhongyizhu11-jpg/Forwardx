import assert from "node:assert/strict";
import test from "node:test";
import { resolveForwardRuleStopReason } from "./forwardRuleStatus";

test("stop reason tells automatic stops apart from manual ones", () => {
  assert.equal(resolveForwardRuleStopReason({ isEnabled: true, disabledByTunnel: true }), null);
  assert.deepEqual(
    [resolveForwardRuleStopReason({ isEnabled: 0, disabledByTunnel: 1 })?.label, resolveForwardRuleStopReason({ isEnabled: 0, disabledByTunnel: 1 })?.autoResume],
    ["隧道停用", true],
  );
  assert.equal(resolveForwardRuleStopReason({ isEnabled: false, disabledByGroup: true })?.label, "资源停用");
  // 账户暂停优先：隧道恢复后它仍然要等账户恢复。
  assert.equal(resolveForwardRuleStopReason({ isEnabled: false, disabledByUser: true, disabledByTunnel: true })?.label, "账户暂停");
  const manual = resolveForwardRuleStopReason({ isEnabled: false });
  assert.equal(manual?.autoResume, false);
  assert.match(manual?.detail || "", /手动/);
  assert.equal(resolveForwardRuleStopReason({ isEnabled: false, protocolBlockReason: "端口冲突" })?.detail, "端口冲突");
});
