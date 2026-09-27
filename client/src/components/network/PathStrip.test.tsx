import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PathLine, PathStrip } from "./PathStrip";

test("路径条：两头各一个节点，线的颜色是状态色，中间的药丸写经过什么", () => {
  const html = renderToStaticMarkup(
    <PathStrip entry={{ name: "HK entry 01", address: "hk.example:443" }} target={{ address: "10.0.0.1:443" }} health="healthy" via="iptables · TCP" />,
  );
  assert.match(html, /data-health="healthy"/);
  assert.match(html, /<b>HK entry 01<\/b><span>hk.example:443<\/span>/);
  assert.match(html, /<b>目标<\/b><span>10.0.0.1:443<\/span>/);
  assert.match(html, /fx-pathstrip-label[^>]*>iptables · TCP/);
  assert.doesNotMatch(html, /fx-pathstrip-wire-dashed/);
  assert.match(html, /--fx-pathstrip-color:var\(--fx-healthy\)/);
});

test("路径条：中断是虚线；中继画成线上的小圆点，名字写进药丸", () => {
  const html = renderToStaticMarkup(
    <PathStrip entry={{ name: "A", address: "a:1" }} target={{ address: "b:2" }} health="down" via="GOST" hops={["HK relay", "JP relay"]} />,
  );
  assert.match(html, /fx-pathstrip-wire-dashed/);
  assert.match(html, /--fx-pathstrip-color:var\(--fx-down\)/);
  assert.equal((html.match(/fx-pathstrip-hop"/g) || []).length, 2);
  assert.match(html, /经 HK relay › JP relay/);
});

test("列表行里的一小段线：断了就是虚线", () => {
  const ok = renderToStaticMarkup(<PathLine from="A" to="B" health="healthy" />);
  const bad = renderToStaticMarkup(<PathLine from="A" to="B" health="down" />);
  assert.doesNotMatch(ok, /fx-pathline-ln-dashed/);
  assert.match(bad, /fx-pathline-ln-dashed/);
  assert.match(bad, /--fx-pathline-color:var\(--fx-down\)/);
});
