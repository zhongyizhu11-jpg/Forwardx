import assert from "node:assert/strict";
import test from "node:test";

import { buildNetworkMapModel } from "./NetworkMapSection";

const now = 1_700_000_000_000;
const online = (id: number, name: string) => ({ id, name, isOnline: true, lastHeartbeat: now - 1000 });

test("经过看不到的主机的共享隧道照样计数，只是画不成线", () => {
  // 服务端给普通用户抹掉了出口（linkAccessView）：hopHostIds 只剩入口，exitHostId 为 null。
  const model = buildNetworkMapModel({
    now,
    hosts: [online(1, "visible")],
    tunnels: [{
      id: 10,
      name: "shared",
      mode: "tls",
      isEnabled: true,
      entryHostId: 1,
      exitHostId: null,
      hopHostIds: [1],
      availability: { status: "available", available: true, source: "hosts", message: "online" },
    }],
  });
  assert.equal(model.links.length, 0, "一个点画不出线");
  assert.equal(model.linkTotal, 1);
  assert.equal(model.hiddenLinkCount, 1);
  assert.equal(model.legend.healthy, 1, "状态来自服务端算好的 availability");
  assert.equal(model.nodes[0].note, "1 条线路");
});

test("协议被停用的隧道在地图上和隧道页一样是中断", () => {
  const hosts = [online(1, "a"), online(2, "b")];
  const tunnels = [{ id: 1, name: "t", mode: "tls", isEnabled: true, entryHostId: 1, exitHostId: 2 }];
  const supported = buildNetworkMapModel({ now, hosts, tunnels, isTunnelSupported: () => true });
  assert.equal(supported.links[0].health, "healthy");
  const unsupported = buildNetworkMapModel({ now, hosts, tunnels, isTunnelSupported: () => false });
  assert.equal(unsupported.links[0].health, "down");
  assert.deepEqual(unsupported.legend, { healthy: 0, degraded: 0, down: 1, standby: 0 });
});

test("两端都看得见时正常画线，停用的隧道是待命", () => {
  const model = buildNetworkMapModel({
    now,
    hosts: [online(1, "a"), online(2, "b"), { id: 3, name: "c", isOnline: false, lastHeartbeat: now - 5 * 60_000 }],
    tunnels: [
      { id: 1, name: "live", mode: "forwardx", isEnabled: true, entryHostId: 1, exitHostId: 2 },
      { id: 2, name: "paused", mode: "forwardx", isEnabled: false, entryHostId: 1, exitHostId: 3 },
    ],
  });
  assert.equal(model.links.length, 2);
  assert.equal(model.hiddenLinkCount, 0);
  assert.equal(model.links[1].health, "standby");
  assert.equal(model.nodes[0].note, "2 条线路");
  assert.equal(model.nodes[2].note, "离线 · 5 分钟前");
});
