import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { HostRegionBadge } from "./hostDisplay";
import { hostLocationPayload, hostLocationValueFromHost } from "./HostLocationPicker";

/**
 * 卡片上的位置文案：手动指定的要挂「手动」标签；没定到位的不再一直「地区获取中」，
 * 给了回调就画成能点的「未定位 · 点此设置」。
 */
test("HostRegionBadge：手动位置挂「手动」标签", () => {
  const html = renderToStaticMarkup(
    <HostRegionBadge host={{ geoCountryCode: "HK", geoCountryName: "中国香港", geoRegion: "香港", geoManual: true }} />,
  );
  assert.match(html, /中国香港 \/ 香港/);
  assert.match(html, />手动</);
});

test("HostRegionBadge：没定到位 + 有回调 → 「未定位 · 点此设置」按钮；没回调还是「地区获取中」", () => {
  const withHandler = renderToStaticMarkup(<HostRegionBadge host={{}} onSetLocation={() => {}} />);
  assert.match(withHandler, /<button[^>]*>未定位 · 点此设置<\/button>/);
  const withoutHandler = renderToStaticMarkup(<HostRegionBadge host={{}} />);
  assert.match(withoutHandler, /地区获取中/);
  assert.doesNotMatch(withoutHandler, /<button/);
});

test("表单初值：手动且在城市表里的选中那座城市，不在表里的落到自定义经纬度", () => {
  assert.equal(hostLocationValueFromHost({ geoManual: false, geoCountryCode: "US", geoRegion: "California" }).mode, "auto");
  const city = hostLocationValueFromHost({ geoManual: true, geoCountryCode: "CN", geoRegion: "深圳", geoLatitudeMicro: 22543100, geoLongitudeMicro: 114057900 });
  assert.equal(city.mode, "city");
  assert.equal(city.cityKey, "CN/Shenzhen");
  const custom = hostLocationValueFromHost({ geoManual: true, geoCountryCode: "HK", geoRegion: "葵涌机房", geoLatitudeMicro: 22363000, geoLongitudeMicro: 114130000 });
  assert.equal(custom.mode, "custom");
  assert.equal(custom.countryCode, "HK");
  assert.equal(custom.latitude, "22.363");
  assert.equal(custom.longitude, "114.13");
});

test("提交载荷：自动只带 geoManual=false；城市展开成坐标；自定义要过范围校验", () => {
  assert.deepEqual(hostLocationPayload({ mode: "auto", cityKey: "", countryCode: "", region: "", latitude: "", longitude: "" }), { ok: true, payload: { geoManual: false } });
  const city = hostLocationPayload({ mode: "city", cityKey: "HK/Hong Kong", countryCode: "", region: "", latitude: "", longitude: "" });
  assert.ok(city.ok);
  assert.deepEqual(city.payload, { geoManual: true, geoCountryCode: "HK", geoRegion: "香港", geoLatitude: 22.3193, geoLongitude: 114.1694 });
  const noCity = hostLocationPayload({ mode: "city", cityKey: "", countryCode: "", region: "", latitude: "", longitude: "" });
  assert.equal(noCity.ok, false);
  const badLat = hostLocationPayload({ mode: "custom", cityKey: "", countryCode: "hk", region: "", latitude: "95", longitude: "114" });
  assert.equal(badLat.ok, false);
  assert.match(badLat.ok ? "" : badLat.error, /纬度/);
  const badCode = hostLocationPayload({ mode: "custom", cityKey: "", countryCode: "H", region: "", latitude: "22", longitude: "114" });
  assert.equal(badCode.ok, false);
  const good = hostLocationPayload({ mode: "custom", cityKey: "", countryCode: "hk", region: " 葵涌 ", latitude: "22.36", longitude: "114.13" });
  assert.ok(good.ok);
  assert.deepEqual(good.payload, { geoManual: true, geoCountryCode: "HK", geoRegion: "葵涌", geoLatitude: 22.36, geoLongitude: 114.13 });
});
