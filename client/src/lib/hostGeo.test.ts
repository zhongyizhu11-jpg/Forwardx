import assert from "node:assert/strict";
import test from "node:test";

import { escapeTooltipHtml, hostGeoCoordinate, hostMapClusterDistance, longitudeDistanceDegrees } from "./hostGeo";

/**
 * 这四个助手原来在四个页面里各存一份（主机地图、链路管理、转发规则、主机管理）。
 * 合成一份之后，同一台机器在四张图上必须落在同一个点、气泡里必须转义同一批字符。
 */

test("库里存的微度整数换算成度", () => {
  assert.deepEqual(hostGeoCoordinate({ geoLatitudeMicro: 22_396_400, geoLongitudeMicro: 114_109_400 }), {
    lat: 22.3964,
    lng: 114.1094,
  });
  assert.deepEqual(hostGeoCoordinate({ geoLatitudeMicro: 0, geoLongitudeMicro: 0 }), { lat: 0, lng: 0 },
    "赤道和本初子午线的交点是合法坐标，不能被当成「没坐标」");
  assert.deepEqual(hostGeoCoordinate({ geoLatitudeMicro: -33_868_800, geoLongitudeMicro: 151_209_300 }), {
    lat: -33.8688,
    lng: 151.2093,
  }, "南半球和负经度照常");
});

test("没有坐标、或坐标不合法时回 null，不夹到边界", () => {
  /*
    夹一下会把一台坐标写坏的机器稳稳地画在北极点 —— 看起来像真的，
    人会以为那儿真有台机器。回 null 是老实说不知道，地图上就不画它。
  */
  assert.equal(hostGeoCoordinate(null), null);
  assert.equal(hostGeoCoordinate({}), null);
  assert.equal(hostGeoCoordinate({ geoLatitudeMicro: 22_396_400 }), null, "只有一半坐标不算坐标");
  assert.equal(hostGeoCoordinate({ geoLatitudeMicro: 91_000_000, geoLongitudeMicro: 0 }), null, "纬度超 90");
  assert.equal(hostGeoCoordinate({ geoLatitudeMicro: 0, geoLongitudeMicro: 181_000_000 }), null, "经度超 180");
  assert.equal(hostGeoCoordinate({ geoLatitudeMicro: "x", geoLongitudeMicro: 0 }), null, "脏值");
});

test("气泡里的尖括号和引号要转义", () => {
  // 地图气泡是拼 HTML 字符串塞进去的，主机名是用户自己填的。
  assert.equal(escapeTooltipHtml('<img src=x onerror="alert(1)">'),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  assert.equal(escapeTooltipHtml("A & B's 机器"), "A &amp; B&#39;s 机器");
  assert.equal(escapeTooltipHtml(null), "", "空值给空串，不给 'null'");
  assert.equal(escapeTooltipHtml(0), "0", "0 要显示成 0，不能被当成空");
});

test("经度是环形的", () => {
  assert.equal(longitudeDistanceDegrees(179, -179), 2, "跨换日线只差 2 度，不是 358 度");
  assert.equal(longitudeDistanceDegrees(0, 10), 10);
  assert.equal(longitudeDistanceDegrees(-170, 170), 20);
});

test("聚类距离按纬度缩经度，高纬度上才聚得起来", () => {
  const cluster = { centerLat: 60, centerLng: 0 };
  const near = hostMapClusterDistance({ lat: 60, lng: 2 }, cluster);
  const flat = 2; // 不缩的话这一步就是 2 度
  assert.ok(near < flat, `高纬度上两度经度应当被缩短（实得 ${near}）`);
  // 同样的经度差放在赤道上，缩放系数接近 1，所以距离更大。
  const equator = hostMapClusterDistance({ lat: 0, lng: 2 }, { centerLat: 0, centerLng: 0 });
  assert.ok(equator > near, "赤道上的两度比高纬度的两度远");
  assert.equal(hostMapClusterDistance({ lat: 10, lng: 20 }, { centerLat: 10, centerLng: 20 }), 0, "同一个点距离是 0");
});
