import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 折扣码预览的试码限流。
 *
 * 门上了锁、旁边的窗户开着：兑换码那条路早就有按用户/按来源的试错限流，而折扣码
 * 预览一点都没有 —— 两条都是「拿一个码来问对不对」。折扣码是管理员手打的
 * （`SALE50` 这类），好猜；预览对不存在的码直接回「折扣码不存在」，是个干净的
 * 探测口。任何登录用户都能全速试，把商家还没公布的、或只发给某个客户的码翻出来。
 *
 * 这一组钉三件事：试错会被拦；**拦的是试错、不是正常使用**（对的码问多少次都不
 * 该被封）；折扣码和兑换码**各记各的账**（不然正常结账会被隔壁的试错误伤）。
 */
test("折扣码预览：试错会被封，正确的码不受影响，且不牵连兑换码", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-discount-rl-"));
  const databasePath = path.join(directory, "discount.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (f) => pathToFileURL(path.join(process.cwd(), f)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const billing = await import(url("server/repositories/billingRepository.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (s, p = []) => runtime.executeRaw(s, p);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, '张三', 'h', 'user')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (3, '李四', 'h', 'user')");
    await billing.createDiscountCode({
      code: "SALE50", discountType: "percent", discountValue: 50, isActive: true, maxUses: 0,
    }, []);

    const preview = (code, actor) => billing.previewDiscount(code, 10000, undefined, actor);
    const zhangsan = { userId: 2, attemptScope: "10.0.0.2" };

    // 一、正确的码照常能用，且不该被记成失败
    const ok = await preview("SALE50", zhangsan);
    assert.equal(ok.finalAmountCents, 5000, "五折应当是 5000");

    /*
      一之二、「码是对的、但不适用于这个套餐」**不该计入失败**。

      结账时手里有几张码、试到一张是别的套餐的，是很正常的事；如果这也扣额度，
      扣满就把人挡在付款外面。拦试码的人，不该拦正在掏钱的人。
      而安全上也不亏：要遍历套餐得先有一个有效码，拿到有效码走的是「不存在」
      那条路，那条是计数的。
    */
    await billing.createDiscountCode({
      code: "PLANONLY", discountType: "percent", discountValue: 10, isActive: true, maxUses: 0,
    }, [12345]);
    for (let i = 0; i < 12; i++) {
      await assert.rejects(() => preview("PLANONLY", zhangsan), /不适用于该套餐/);
    }
    const stillFine = await preview("SALE50", zhangsan);
    assert.equal(stillFine.finalAmountCents, 5000, "问了 12 次「不适用」之后仍不该被封");

    // 二、连续试错到阈值（按用户 8 次）之后要被拦住
    let blockedAt = 0;
    for (let i = 1; i <= 12; i++) {
      try {
        await preview("NOPE" + i, zhangsan);
        assert.fail("不存在的码应当抛错");
      } catch (error) {
        const message = String(error && error.message || error);
        if (/试得太频繁/.test(message)) { blockedAt = i; break; }
        assert.match(message, /折扣码不存在/, "被拦之前应当只是「不存在」");
      }
    }
    assert.ok(blockedAt > 0, "一直试都没被拦住 —— 限流没生效");
    assert.ok(blockedAt <= 10, "拦得太晚了，第 " + blockedAt + " 次才拦");

    // 三、拦的是这个人，不是所有人
    const other = await preview("SALE50", { userId: 3, attemptScope: "10.0.0.3" });
    assert.equal(other.finalAmountCents, 5000, "别人不该被牵连");

    // 四、被封的人连正确的码也问不了（这是封禁该有的样子，不是 bug）
    await assert.rejects(() => preview("SALE50", zhangsan), /试得太频繁/);

    /*
      五、折扣码和兑换码各记各的账。

      这条最要紧：如果两类共用一个计数器，一个人在结账页多试几次折扣码，就会把
      他兑换礼品码的额度一起吃掉 —— 拦的就从「试码的人」变成「正常用的人」了。
    */
    await assert.rejects(
      () => billing.redeemCode(2, "WHATEVER", "10.0.0.2"),
      (error) => {
        const message = String(error && error.message || error);
        assert.ok(!/试得太频繁/.test(message), "折扣码的封禁串到兑换码上了");
        return /兑换码|不存在|无效/.test(message);
      },
      "兑换码那条路不该被折扣码的试错影响",
    );

    console.log("DISCOUNT_RL_OK");
    await runtime.closeDatabase().catch(() => undefined);
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, NODE_ENV: "test" },
      timeout: 120000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /DISCOUNT_RL_OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
