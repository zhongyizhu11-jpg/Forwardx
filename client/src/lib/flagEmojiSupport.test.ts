import { test } from "node:test";
import assert from "node:assert/strict";
import { countryFlagLabel, flagEmojiRenders, isCountryCodeLabel, resetFlagEmojiCache } from "./flagEmojiSupport";

function withFakeCanvas(pixels: (i: number) => [number, number, number, number], run: () => void) {
  const data = new Uint8ClampedArray(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i++) {
    const [r, g, b, a] = pixels(i);
    data.set([r, g, b, a], i * 4);
  }
  const fakeDocument = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ textBaseline: "", font: "", fillText() {}, getImageData: () => ({ data }) }),
    }),
  };
  (globalThis as any).document = fakeDocument;
  try {
    resetFlagEmojiCache();
    run();
  } finally {
    delete (globalThis as any).document;
    resetFlagEmojiCache();
  }
}

test("没有 DOM（服务端、测试）时按能画处理，直接给 emoji", () => {
  resetFlagEmojiCache();
  assert.equal(flagEmojiRenders("🇹🇼"), true);
  assert.equal(countryFlagLabel("tw"), "🇹🇼");
});

test("画出来只有黑灰线条（缺字的方框）→ 退回两字母代码", () => {
  withFakeCanvas((i) => (i % 3 === 0 ? [20, 20, 20, 255] : [0, 0, 0, 0]), () => {
    assert.equal(flagEmojiRenders("🇹🇼"), false);
    assert.equal(countryFlagLabel("TW"), "TW");
    assert.equal(countryFlagLabel(" tw "), "TW");
  });
});

test("画出来有彩色像素（真旗子）→ 用 emoji", () => {
  withFakeCanvas((i) => (i < 40 ? [220, 30, 30, 255] : [0, 0, 0, 0]), () => {
    assert.equal(flagEmojiRenders("🇭🇰"), true);
    assert.equal(countryFlagLabel("HK"), "🇭🇰");
  });
});

test("空代码给空串；两字母判断只认大写字母", () => {
  assert.equal(countryFlagLabel(""), "");
  assert.equal(countryFlagLabel(null), "");
  assert.equal(isCountryCodeLabel("TW"), true);
  assert.equal(isCountryCodeLabel("🇹🇼"), false);
  assert.equal(isCountryCodeLabel("tw"), false);
});
