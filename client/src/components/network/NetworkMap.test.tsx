import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { layoutNetworkMap, NetworkMap, type NetworkMapNode } from "./NetworkMap";

const node = (id: number, extra: Partial<NetworkMapNode> = {}): NetworkMapNode => ({ id, name: `主机 ${id}`, health: "healthy", ...extra });

test("布局：所有节点都落在画布里，两两之间不叠在一起", () => {
  const placed = layoutNetworkMap([1, 2, 3, 4, 5, 6].map((id) => node(id)), 360, 220);
  assert.equal(placed.length, 6);
  for (const p of placed) {
    assert.ok(p.x >= 0 && p.x <= 360 && p.y >= 0 && p.y <= 220, `${p.name} 在画布里 (${p.x}, ${p.y})`);
  }
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const dx = Math.abs(placed[i].x - placed[j].x), dy = Math.abs(placed[i].y - placed[j].y);
      assert.ok(dx >= 40 || dy >= 40, `${placed[i].name} 和 ${placed[j].name} 分得开 (${dx}, ${dy})`);
    }
  }
});

test("布局：有经纬度时西边的机器在左边，同城的两台也不会叠成一个点", () => {
  const placed = layoutNetworkMap([
    node(1, { name: "US", geo: { lat: 37.7, lng: -122.4 } }),
    node(2, { name: "HK-a", geo: { lat: 22.3, lng: 114.2 } }),
    node(3, { name: "HK-b", geo: { lat: 22.3, lng: 114.2 } }),
    node(4, { name: "JP", geo: { lat: 35.7, lng: 139.7 } }),
  ], 360, 220);
  const by = Object.fromEntries(placed.map((p) => [p.name, p]));
  assert.ok(by.US.x < by["HK-a"].x && by["HK-a"].x < by.JP.x + 1, "从西到东");
  const dx = Math.abs(by["HK-a"].x - by["HK-b"].x), dy = Math.abs(by["HK-a"].y - by["HK-b"].y);
  assert.ok(dx >= 40 || dy >= 40, `同城两台分开了 (${dx}, ${dy})`);
});

test("渲染：正常的线是实线走渐变，中断的线是红虚线，节点环的颜色是状态色", () => {
  const html = renderToStaticMarkup(
    <NetworkMap
      nodes={[node(1), node(2, { health: "down", note: "离线 · 3 分钟前" }), node(3)]}
      links={[
        { id: 10, name: "ok", path: [1, 3], health: "healthy", latencyMs: 46 },
        { id: 11, name: "bad", path: [1, 2], health: "down" },
      ]}
    />,
  );
  assert.match(html, /stroke="url\(#fx-netmap-wire\)"(?![^>]*stroke-dasharray)/);
  assert.match(html, /stroke="var\(--fx-down\)"[^>]*stroke-dasharray="6 5"/);
  assert.match(html, /<circle r="13" fill="var\(--fx-l1-surface\)" stroke="var\(--fx-down\)"/);
  assert.match(html, /离线 · 3 分钟前/);
  assert.match(html, /ok · 46 ms/);
  assert.match(html, /aria-label="网络地图：3 台主机，2 条线路"/);
});
