import assert from "node:assert/strict";
import test from "node:test";
import { forwardAccessBlockedReasonText, forwardAccessRestoredNote, forwardAccessResultMessage } from "./forwardAccessMessage";

test("真的开起来了才说已开启", () => {
  assert.deepEqual(
    forwardAccessResultMessage({ requested: true, effective: true, reason: null }),
    { tone: "success", text: "用户转发已开启" },
  );
  assert.deepEqual(
    forwardAccessResultMessage({ requested: false, effective: false, reason: "manual" }),
    { tone: "success", text: "用户转发已关闭" },
  );
});

/**
 * 这一条是这个模块存在的理由。
 *
 * 超额的用户拨开启：服务端记下管理员的意图，但生效值仍然是关。原来照着请求值报
 * 「用户转发已开启」—— toast 说开了，开关还是灰的。
 */
test("没真开起来就不能说已开启，还要说清为什么和下一步", () => {
  const message = forwardAccessResultMessage({ requested: true, effective: false, reason: "traffic_limit" });
  assert.equal(message.tone, "warning");
  assert.ok(!message.text.includes("已开启"), `不能说成功：${message.text}`);
  assert.match(message.text, /没能开启/);
  assert.match(message.text, /超额/);
  assert.match(message.text, /重置流量统计或调高额度/, "只说原因不给出路，人还是不知道干嘛");
});

test("三种拦法各说各的", () => {
  assert.match(forwardAccessBlockedReasonText("traffic_limit"), /超额/);
  assert.match(forwardAccessBlockedReasonText("expired"), /到期/);
  assert.match(forwardAccessBlockedReasonText("traffic_billing_balance"), /余额不足/);
});

test("拿不到原因时不硬编一个", () => {
  for (const bad of [null, undefined, "manual", "某个以后新增的原因"]) {
    const text = forwardAccessBlockedReasonText(bad as any);
    assert.match(text, /检查这个账户的额度、有效期和余额/, String(bad));
  }
});

/** 老服务端不回生效值。那就只说做了什么请求，别替它打包票，也别平白报警。 */
test("服务端没给生效值时按请求值说，不报警", () => {
  assert.deepEqual(
    forwardAccessResultMessage({ requested: true }),
    { tone: "success", text: "用户转发已开启" },
  );
  assert.deepEqual(
    forwardAccessResultMessage({ requested: true, effective: null }),
    { tone: "success", text: "用户转发已开启" },
  );
});

test("请求关却还开着，也要说出来", () => {
  const message = forwardAccessResultMessage({ requested: false, effective: true });
  assert.equal(message.tone, "warning");
  assert.match(message.text, /关闭没有生效/);
});

test("恢复提示：没恢复就别加废话", () => {
  assert.equal(forwardAccessRestoredNote(false), null);
  assert.equal(forwardAccessRestoredNote(undefined), null);
  assert.equal(forwardAccessRestoredNote(null), null);
});

test("恢复提示分得清对谁说", () => {
  /*
    同一个信号，管理员那边是「该用户的转发回来了」，租户自己那边是「你的转发回来了」。
    用错人称在余额这种事上很刺眼 —— 租户充完值看到「该用户」，会以为扣错了人的钱。
  */
  assert.equal(forwardAccessRestoredNote(true, "user"), "该用户被暂停的转发已恢复");
  assert.equal(forwardAccessRestoredNote(true, "self"), "你被暂停的转发已恢复");
  assert.equal(forwardAccessRestoredNote(true), "该用户被暂停的转发已恢复", "默认按管理员视角，客户端那几处必须显式传 self");
});
