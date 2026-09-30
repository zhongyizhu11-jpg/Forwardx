import assert from "node:assert/strict";
import test from "node:test";
import { GEO_CITIES, findGeoCityByKey, geoCityKey, geoCountryNameZh, matchGeoCity, searchGeoCities } from "./geoCities";

/**
 * 这张表是离线的，改错一个坐标没人会报错 —— 地图上只会多一个点飘在海里。
 * 所以这里把「表本身合法」当成测试：数量、唯一、坐标范围。
 */
test("城市表：条目够多、键唯一、坐标在范围内", () => {
  assert.ok(GEO_CITIES.length >= 200, `至少 200 条，现在 ${GEO_CITIES.length}`);
  const keys = new Set<string>();
  const zhNames = new Set<string>();
  for (const city of GEO_CITIES) {
    assert.match(city.code, /^[A-Z]{2}$/, `${city.nameEn} 的国家代码要是两位大写 ISO`);
    assert.ok(city.name.trim() && city.nameEn.trim() && city.country.trim() && city.countryEn.trim(), `${city.nameEn} 有空字段`);
    assert.ok(city.lat >= -90 && city.lat <= 90, `${city.nameEn} 纬度越界：${city.lat}`);
    assert.ok(city.lng >= -180 && city.lng <= 180, `${city.nameEn} 经度越界：${city.lng}`);
    assert.ok(Math.abs(city.lat) > 0.01 || Math.abs(city.lng) > 0.01, `${city.nameEn} 坐标是 0,0`);
    const key = geoCityKey(city);
    assert.ok(!keys.has(key), `重复的 code+英文名：${key}`);
    keys.add(key);
    assert.ok(!zhNames.has(city.name), `重复的中文名：${city.name}`);
    zhNames.add(city.name);
  }
});

test("城市表：用户点名要有的地方都在", () => {
  const nameSet = new Set(GEO_CITIES.map((city) => city.name));
  for (const name of ["广州", "深圳", "上海", "北京", "香港", "澳门", "台北", "高雄", "东京", "首尔", "新加坡", "法兰克福", "伦敦", "洛杉矶", "阿什本", "圣保罗", "约翰内斯堡", "乌兰巴托", "塔什干"]) {
    assert.ok(nameSet.has(name), `缺了 ${name}`);
  }
  assert.equal(geoCountryNameZh("hk"), "中国香港");
  assert.equal(geoCountryNameZh("ZZ"), "ZZ", "不认识的代码原样返回，界面上至少还能看到代码");
});

test("搜索：中文、英文、国家、ISO 代码都能搜，城市名命中排在国家命中前面", () => {
  assert.equal(searchGeoCities("深圳")[0]?.nameEn, "Shenzhen");
  assert.equal(searchGeoCities("tokyo")[0]?.name, "东京");
  assert.equal(searchGeoCities("frank")[0]?.nameEn, "Frankfurt");
  const japan = searchGeoCities("japan");
  assert.ok(japan.length >= 5 && japan.every((city) => city.code === "JP"), "按国家英文名搜出来的全是日本城市");
  const hk = searchGeoCities("HK");
  assert.equal(hk[0]?.nameEn, "Hong Kong");
  const us = searchGeoCities("美国 洛");
  assert.equal(us[0]?.nameEn, "Los Angeles", "多个词要全部命中");
  assert.deepEqual(searchGeoCities("不存在的地方xyz"), []);
  assert.equal(searchGeoCities("").length, 40, "空查询给前 40 条当默认列表");
});

test("键与匹配：能从主机上存的位置反查回表里那一条", () => {
  const shenzhen = GEO_CITIES.find((city) => city.nameEn === "Shenzhen")!;
  assert.equal(findGeoCityByKey(geoCityKey(shenzhen)), shenzhen);
  assert.equal(findGeoCityByKey("XX/Nowhere"), null);
  assert.equal(matchGeoCity({ geoCountryCode: "cn", geoRegion: "深圳" }), shenzhen);
  assert.equal(matchGeoCity({ geoCountryCode: "CN", geoRegion: "shenzhen" }), shenzhen, "英文名也认，大小写不敏感");
  assert.equal(matchGeoCity({ geoCountryCode: "US", geoRegion: "深圳" }), null, "国家不对就不匹配");
  assert.equal(matchGeoCity({ geoCountryCode: "CN", geoRegion: "Guangdong" }), null, "省份不是城市");
});
