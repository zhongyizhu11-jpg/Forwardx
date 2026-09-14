import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canAddSelfServiceHost, selfServiceHostLimitForUser } from "./routers/hosts";

/**
 * 「这个租户能自助加几台机器」。
 *
 * 原来只有一个全局设置，所有人一个数。想给某个人多开两台就得把全体调高。
 *
 * 关键取舍：用户行上的 0 表示**跟随全局**，不是「不限」。别的配额（maxRules、
 * maxProxyInbounds）0 都是不限，这里刻意不一样 —— 因为全局那一档本来就是个真实
 * 上限（默认 10 台）。要是 0 也当成不限，管理员把某人调成 0 反而等于给他松了绑，
 * 恰好和他想做的事相反。那种「填 0 结果全放开」的字段迟早出事。
 */
test("没给这个人单独设，就用全局那一档", () => {
  assert.equal(selfServiceHostLimitForUser({ maxSelfServiceHosts: 0 }, 10), 10);
  assert.equal(selfServiceHostLimitForUser({}, 10), 10);
  assert.equal(selfServiceHostLimitForUser(null, 10), 10);
  assert.equal(selfServiceHostLimitForUser(undefined, 3), 3);
});

test("给这个人单独设了就用他的，不管全局是多少", () => {
  assert.equal(selfServiceHostLimitForUser({ maxSelfServiceHosts: 2 }, 10), 2, "调低");
  assert.equal(selfServiceHostLimitForUser({ maxSelfServiceHosts: 50 }, 10), 50, "调高");
});

test("0 是跟随全局，不是不限 —— 调成 0 不能反而把人放开", () => {
  const limit = selfServiceHostLimitForUser({ maxSelfServiceHosts: 0 }, 1);
  assert.equal(limit, 1);
  assert.equal(
    canAddSelfServiceHost({ role: "user" }, 1, limit),
    false,
    "填 0 之后还能无限加的话，这个字段就是个陷阱",
  );
});

test("脏值一律回落到全局，不会算出一个负数上限", () => {
  for (const bad of [-5, "abc", null, undefined, NaN]) {
    assert.equal(selfServiceHostLimitForUser({ maxSelfServiceHosts: bad }, 10), 10, String(bad));
  }
});

test("管理员不受这个限制 —— 拦了反而碍事", () => {
  assert.equal(canAddSelfServiceHost({ role: "admin" }, 999, 1), true);
});

/** 光有解析逻辑不够：这一列得真的存得下、读得回来。 */
test("SQLite 管理员设的台数存得下、读得回来", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-limit-"));
  const databasePath = path.join(directory, "host-limit.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const users = await import(url("server/repositories/userRepository.ts"));
    const billing = await import(url("server/repositories/billingRepository.ts"));
    const { selfServiceHostLimitForUser } = await import(url("server/routers/hosts.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    await runtime.executeRaw("INSERT INTO users (id, username, password, role) VALUES (1,'tenant','h','user')");

    const fresh = await users.getUserById(1);
    assert.equal(Number(fresh.maxSelfServiceHosts || 0), 0, "新用户默认跟随全局");
    assert.equal(selfServiceHostLimitForUser(fresh, 10), 10);

    // 走管理员那条真实路径（users 路由最后调的就是它），别测一个不存在的函数。
    await billing.updateUserManualEntitlements(1, { maxSelfServiceHosts: 3 });
    const capped = await users.getUserById(1);
    assert.equal(Number(capped.maxSelfServiceHosts), 3, "管理员设的数要真的落库");
    assert.equal(selfServiceHostLimitForUser(capped, 10), 3, "落库之后要压过全局");

    console.log("OK");
    await runtime.closeDatabase();
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 90_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
