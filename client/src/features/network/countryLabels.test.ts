import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { countryLabelAnchors, countryLabelText, featureLabelPoint } from "./countryLabels";

const square = (x: number, y: number, size: number) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];

test("标注点：多块陆地的国家取最大那块的形心", () => {
  assert.deepEqual(featureLabelPoint({ geometry: { type: "Polygon", coordinates: [square(0, 0, 10)] } }), [5, 5]);
  assert.deepEqual(featureLabelPoint({ geometry: { type: "MultiPolygon", coordinates: [[square(100, 0, 2)], [square(-10, -10, 8)]] } }), [-6, -6]);
  assert.equal(featureLabelPoint({ geometry: null }), null);
});

test("代码：先认 ISO_A2，-99 的再认 WB_A2；同一个代码只取第一个", () => {
  const anchors = countryLabelAnchors({
    features: [
      { properties: { ISO_A2: "-99", WB_A2: "FR" }, geometry: { type: "Polygon", coordinates: [square(0, 40, 4)] } },
      { properties: { ISO_A2: "AU" }, geometry: { type: "Polygon", coordinates: [square(120, -30, 10)] } },
      { properties: { ISO_A2: "-99", POSTAL: "AU" }, geometry: { type: "Polygon", coordinates: [square(0, 0, 1)] } },
    ],
  });
  assert.deepEqual(anchors.get("FR"), [2, 42]);
  assert.deepEqual(anchors.get("AU"), [125, -25]);
});

test("真实的 110m 国界：中国、美国、澳大利亚、日本的标注点落在本土", () => {
  const file = path.resolve(import.meta.dirname, "../../../public/globe/ne_110m_admin_0_countries.geojson");
  const anchors = countryLabelAnchors(JSON.parse(fs.readFileSync(file, "utf8")));
  const near = (code: string, lng: number, lat: number, tolerance: number) => {
    const point = anchors.get(code);
    assert.ok(point, `${code} 有标注点`);
    assert.ok(Math.abs(point![0] - lng) < tolerance && Math.abs(point![1] - lat) < tolerance, `${code} 在 ${point}`);
  };
  near("CN", 103, 36, 6);
  near("US", -98, 39, 6);
  near("AU", 134, -25, 5);
  near("JP", 138, 37, 4);
  assert.ok(anchors.has("FR"), "法国的 ISO_A2 是 -99 也认得出来");
});

test("中文名：Intl 给得出就用，给不出退回传进来的名字", () => {
  assert.equal(countryLabelText("AU"), "澳大利亚");
  assert.equal(countryLabelText("JP"), "日本");
  assert.equal(countryLabelText("XQ", "Nowhere"), "Nowhere");
});
