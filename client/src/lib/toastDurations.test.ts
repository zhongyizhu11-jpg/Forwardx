import assert from "node:assert/strict";
import test from "node:test";
import { SHORT_TOAST_DURATION_MS, installShortToastDurations } from "./toastDurations";

test("success, info and plain toasts get the short duration; errors keep the default", () => {
  const calls: Array<{ kind: string; data: any }> = [];
  const record = (kind: string) => (_message: unknown, data?: any) => {
    calls.push({ kind, data });
    return 1;
  };
  const fake: any = {
    success: record("success"),
    info: record("info"),
    message: record("message"),
    error: record("error"),
    warning: record("warning"),
  };
  installShortToastDurations(fake);
  fake.success("规则已更新");
  fake.info("提示");
  fake.message("普通");
  fake.error("出错了");
  fake.warning("注意");
  fake.success("自定义时长", { duration: 7000 });

  assert.equal(calls[0].data.duration, SHORT_TOAST_DURATION_MS);
  assert.equal(calls[1].data.duration, SHORT_TOAST_DURATION_MS);
  assert.equal(calls[2].data.duration, SHORT_TOAST_DURATION_MS);
  assert.equal(calls[3].data, undefined);
  assert.equal(calls[4].data, undefined);
  assert.equal(calls[5].data.duration, 7000);
});
