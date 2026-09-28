import assert from "node:assert/strict";
import test from "node:test";
import { hostsRouter } from "./routers/hosts";
import { usersRouter } from "./routers/users";
import { billingRouter } from "./routers/billing";
import { tunnelsRouter } from "./routers/tunnels";
import { rulesRouter } from "./routers/rules";
import { forwardGroupsRouter } from "./routers/forwardGroups";

/**
 * 这些数字都直接进 SQL（LIMIT、整数列）或者当端口用：小数、负数、超大值要在入口就被
 * 挡成清楚的校验错误，而不是落到库里被截断、报一个看不懂的驱动错误，或者拖出整张表。
 * 校验在处理函数之前发生，所以这里不用建库。
 */
const admin = { user: { id: 1, role: "admin", username: "admin" }, req: { headers: {} }, res: { setHeader: () => {} } } as any;

async function rejectsInput(run: () => Promise<unknown>, label: string) {
  await assert.rejects(run, (error: any) => error?.code === "BAD_REQUEST", label);
}

test("数字入参的整数与上下界校验", async () => {
  await rejectsInput(() => hostsRouter.createCaller(admin).metrics({ hostId: 1, limit: 5000 }), "metrics limit 超过 1440");
  await rejectsInput(() => hostsRouter.createCaller(admin).metrics({ hostId: 1, limit: 0 }), "metrics limit 为 0");
  await rejectsInput(() => hostsRouter.createCaller(admin).metrics({ hostId: 1, limit: 2.5 }), "metrics limit 是小数");

  const users = usersRouter.createCaller(admin);
  await rejectsInput(() => users.updateTrafficSettings({ userId: 2, trafficResetDay: 1.5 }), "重置日是小数");
  await rejectsInput(() => users.updateTrafficSettings({ userId: 2, trafficResetDay: 32 }), "重置日超过 31");
  await rejectsInput(() => users.updateTrafficSettings({ userId: 2, maxRules: 2.5 }), "规则数上限是小数");
  await rejectsInput(() => users.updateTrafficSettings({ userId: 2, maxPorts: 2 ** 31 }), "端口数上限超过 int 列");
  await rejectsInput(() => users.updateTrafficSettings({ userId: 2, trafficLimit: 1.5 }), "流量额度不是整字节");
  await rejectsInput(() => users.updateTrafficSettings({ userId: 2, trafficLimit: 2 ** 60 }), "流量额度超过安全整数");

  await rejectsInput(() => billingRouter.createCaller(admin).adminAddTrafficAddon({ userId: 2, trafficBytes: 2 ** 60 }), "附加流量超过安全整数");

  await rejectsInput(() => tunnelsRouter.createCaller(admin).update({ id: 1, listenPort: 443.5 } as any), "隧道监听端口是小数");
  await rejectsInput(() => rulesRouter.createCaller(admin).checkPort({ hostId: 1, sourcePort: 80.5 }), "检查端口是小数");
  await rejectsInput(() => rulesRouter.createCaller(admin).update({ id: 1, targetPort: 443.5 } as any), "目标端口是小数");

  await rejectsInput(() => forwardGroupsRouter.createCaller(admin).reorder({ groupId: 1, memberIds: [1.5] }), "成员 id 是小数");
});
