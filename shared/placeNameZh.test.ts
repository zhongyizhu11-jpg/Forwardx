import assert from "node:assert/strict";
import test from "node:test";

import { countryNameZh, hostPlaceNameZh, nearestGeoCity, normalizeRegionKey, resolvePlaceNameZh } from "./placeNameZh";

/**
 * 用户的首页地图上出现过「Guangdong · 香港 ×4」「Guangdong」「New South Wales」—— IP 定位给的
 * region 是英文。这些用例就是那几台机器的定位字段。
 */
test("英文省 / 州名换成中文：Guangdong → 广东，New South Wales → 新南威尔士", () => {
  assert.equal(resolvePlaceNameZh({ countryCode: "CN", region: "Guangdong" }), "广东");
  assert.equal(resolvePlaceNameZh({ countryCode: "AU", region: "New South Wales" }), "新南威尔士");
  assert.equal(resolvePlaceNameZh({ countryCode: "US", region: "California" }), "加利福尼亚");
  assert.equal(resolvePlaceNameZh({ countryCode: "JP", region: "Kanagawa" }), "神奈川");
  assert.equal(resolvePlaceNameZh({ countryCode: "CN", region: "Guangdong Province" }), "广东");
  assert.equal(resolvePlaceNameZh({ countryCode: "CN", region: "Guangxi Zhuang Autonomous Region" }), "广西");
});

test("region 正好是城市表里的城市：Hong Kong → 香港，Taipei City → 台北", () => {
  assert.equal(resolvePlaceNameZh({ countryCode: "HK", region: "Hong Kong" }), "香港");
  assert.equal(resolvePlaceNameZh({ countryCode: "TW", region: "Taipei City" }), "台北");
  assert.equal(resolvePlaceNameZh({ countryCode: "TW", region: "Taipei City", lat: 25.0478, lng: 121.5319 }), "台北");
  assert.equal(resolvePlaceNameZh({ countryCode: "JP", region: "Tokyo" }), "东京");
});

test("有坐标时按最近的城市（150 km 内）：悉尼的坐标 → 悉尼，洛杉矶的坐标 → 洛杉矶", () => {
  assert.equal(resolvePlaceNameZh({ countryCode: "AU", region: "New South Wales", lat: -33.8715, lng: 151.2006 }), "悉尼");
  assert.equal(resolvePlaceNameZh({ countryCode: "AU", lat: -33.8715, lng: 151.2006 }), "悉尼");
  assert.equal(resolvePlaceNameZh({ countryCode: "US", region: "California", lat: 34.0522, lng: -118.2437 }), "洛杉矶");
  assert.equal(resolvePlaceNameZh({ lat: 34.05, lng: -118.25 }), "洛杉矶");
  // 广东的机器、坐标在广州
  assert.equal(resolvePlaceNameZh({ countryCode: "CN", region: "Guangdong", lat: 23.1167, lng: 113.25 }), "广州");
});

test("同名的州和城市：Washington 州的机器在西雅图，不写成华盛顿", () => {
  assert.equal(resolvePlaceNameZh({ countryCode: "US", region: "Washington", lat: 47.6062, lng: -122.3321 }), "西雅图");
  assert.equal(resolvePlaceNameZh({ countryCode: "US", region: "Washington" }), "华盛顿");
});

test("最近的城市只在同一个国家里找：香港的机器不会因为离深圳近写成深圳", () => {
  assert.equal(resolvePlaceNameZh({ countryCode: "HK", region: "Central and Western", lat: 22.2783, lng: 114.1747 }), "香港");
  assert.equal(nearestGeoCity(22.2783, 114.1747, "CN")?.name, "深圳");
  // 离谁都远：不硬凑
  assert.equal(nearestGeoCity(-60, -30, null), null);
});

test("都查不到：退回国家 / 地区的中文名，最后才写原文", () => {
  assert.equal(resolvePlaceNameZh({ countryCode: "AU", region: "Somewhere Remote" }), "澳大利亚");
  assert.equal(resolvePlaceNameZh({ countryCode: "TW", region: "Taiwan", lat: 0, lng: 0 }), "台湾");
  assert.equal(resolvePlaceNameZh({ countryCode: "HK" }), "香港");
  // 城市表没登记的国家：问 Intl（冰岛）
  assert.equal(resolvePlaceNameZh({ countryCode: "IS", region: "Capital Region" }), "冰岛");
  assert.equal(resolvePlaceNameZh({ region: "Atlantis" }), "Atlantis");
  assert.equal(resolvePlaceNameZh({}), null);
});

test("手动定位、本来就是中文的原样", () => {
  assert.equal(resolvePlaceNameZh({ countryCode: "CN", region: "我家机房", lat: 23.1, lng: 113.3, manual: true }), "我家机房");
  assert.equal(resolvePlaceNameZh({ countryCode: "CN", region: "深圳", lat: 23.1, lng: 113.3 }), "深圳");
});

test("主机行（微度坐标）", () => {
  assert.equal(hostPlaceNameZh({ geoCountryCode: "AU", geoRegion: "New South Wales", geoLatitudeMicro: -33871500, geoLongitudeMicro: 151200600 }), "悉尼");
  assert.equal(hostPlaceNameZh({ geoCountryCode: "CN", geoRegion: "Guangdong" }), "广东");
  assert.equal(hostPlaceNameZh({ geoManual: true, geoCountryCode: "HK", geoRegion: "香港", geoLatitudeMicro: 22319300, geoLongitudeMicro: 114169400 }), "香港");
  assert.equal(hostPlaceNameZh(null), null);
});

test("国家中文名和 region 归一化", () => {
  assert.equal(countryNameZh("MO"), "澳门");
  assert.equal(countryNameZh("cn"), "中国");
  assert.equal(countryNameZh("??"), null);
  assert.equal(normalizeRegionKey("Tokyo-to"), "tokyo");
  assert.equal(normalizeRegionKey("  Hong Kong SAR "), "hong kong");
  assert.equal(normalizeRegionKey("Île-de-France"), "ile-de-france");
});
