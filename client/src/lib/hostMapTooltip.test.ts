import assert from "node:assert/strict";
import test from "node:test";

import { renderHostMapTooltip, type HostMapTooltipPoint } from "./hostMapTooltip";

/**
 * 地图气泡是**拼字符串塞进 innerHTML** 的，而里面几乎每一项都来自用户或 Agent：
 * 机器名是用户填的，系统信息和 Agent 版本是机器报上来的。所以这一组的重点不是
 * 排版好不好看，是「转义有没有漏」和「缺字段时说人话」。
 *
 * 平面地图和 3D 地球原来各抄了一份（889 token、相似度 0.95），合并成这一份之后，
 * 两张图上同一台机器看到的内容必然一致 —— 这正是合并要买下的东西。
 */

const base: HostMapTooltipPoint = {
  name: "HK entry 01",
  addressText: "IPv4 198.51.100.16",
  regionText: "Hong Kong",
  osInfo: "Debian 13",
  agentVersion: "2.2.195",
  statusText: "在线",
  color: "#4ade80",
  glowColor: "rgba(74,222,128,.5)",
  countryCode: "HK",
  flagUrl: "https://flags.example/hk.svg",
};

test("四行都在，Agent 版本自动加 v", () => {
  const html = renderHostMapTooltip(base);
  for (const label of ["地址", "地区", "系统", "Agent"]) {
    assert.ok(html.includes(`>${label}</span>`), `少了「${label}」这一行`);
  }
  assert.ok(html.includes("HK entry 01"));
  assert.ok(html.includes("v2.2.195"), "版本号要带 v 前缀");
  assert.ok(html.includes("在线"));
});

test("机器名里的尖括号必须转义", () => {
  /*
    机器名是用户自己填的，而这段是直接当 HTML 塞进去的。不转义就是一个
    存储型 XSS：管理员打开主机地图，别人填的脚本在他的会话里跑。
  */
  const html = renderHostMapTooltip({ ...base, name: '<img src=x onerror="alert(1)">' });
  assert.ok(!html.includes("<img src=x"), "原样的 img 标签漏进去了");
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
});

test("Agent 报上来的系统信息同样要转义", () => {
  const html = renderHostMapTooltip({ ...base, osInfo: "<script>x</script>" });
  assert.ok(!html.includes("<script>"), "系统信息没转义");
  assert.ok(html.includes("&lt;script&gt;"));
});

test("缺字段时说人话，不显示空白或 undefined", () => {
  const html = renderHostMapTooltip({ ...base, regionText: "", osInfo: "", agentVersion: "" });
  assert.ok(html.includes("地区获取中"));
  assert.ok(html.includes("系统信息未上报"));
  assert.ok(html.includes("未上报"));
  assert.ok(!html.includes("undefined"));
  assert.ok(!html.includes("null"));
});

test("没有名字时给一个短横，不是空白", () => {
  const html = renderHostMapTooltip({ ...base, name: "" });
  assert.ok(html.includes(">-</div>"), "名字为空时该显示 -");
});

test("没有国旗就退回纯文字地区，有国旗则带上国家代码兜底", () => {
  /*
    旗帜走的是外部 CDN，被挡是常事。挡掉之后 onerror 会把 img 藏起来、露出
    国家代码 —— 所以这两段必须同时在，少了哪一半都会变成「地区那一格空着」。
  */
  const withFlag = renderHostMapTooltip(base);
  assert.ok(withFlag.includes("<img src="), "有旗帜时要渲染 img");
  assert.ok(withFlag.includes("onerror="), "要留兜底切换");
  assert.ok(withFlag.includes(">HK<"), "兜底要能露出国家代码");

  const noFlag = renderHostMapTooltip({ ...base, flagUrl: "" });
  assert.ok(!noFlag.includes("<img src="), "没旗帜时不该留空 img");
  assert.ok(noFlag.includes("Hong Kong"));
});

test("颜色直接用调用方给的 CSS 串", () => {
  // 平面地图存的是 deck.gl 的 [r,g,b,a]，由调用方先转好；这里只认字符串。
  const html = renderHostMapTooltip({ ...base, color: "rgb(1,2,3)", glowColor: "rgb(4,5,6)" });
  assert.ok(html.includes("background:rgb(1,2,3)"));
  assert.ok(html.includes("box-shadow:0 0 14px rgb(4,5,6)"));
});
