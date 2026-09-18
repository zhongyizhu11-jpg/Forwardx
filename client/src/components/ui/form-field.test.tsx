import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FormField } from "./form-field";
import { Label } from "./label";
import { Input } from "./input";
import { Textarea } from "./textarea";
import { Select, SelectTrigger, SelectValue } from "./select";

test("repeated fields each connect their label to their own control", () => {
  const html = renderToStaticMarkup(<>
    {[0, 1].map(index => <FormField key={index}><Label>目标地址</Label><Input /></FormField>)}
    <FormField><Label>备注</Label><Textarea /></FormField>
    <FormField><Label>线路</Label><Select><SelectTrigger><SelectValue placeholder="选择线路" /></SelectTrigger></Select></FormField>
  </>);
  const labels = [...html.matchAll(/<label[^>]* for="([^"]+)"/g)].map(match => match[1]);
  const controls = [...html.matchAll(/<(?:input|textarea|button)[^>]* id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(labels.length, 4);
  assert.equal(new Set(labels).size, 4);
  assert.deepEqual(controls, labels);
});

test("explicit ids and labels keep their association", () => {
  const html = renderToStaticMarkup(<FormField><Label htmlFor="existing-port">端口</Label><Input id="existing-port" aria-describedby="port-help" /></FormField>);
  assert.match(html, /for="existing-port"/);
  assert.match(html, /id="existing-port"/);
  assert.match(html, /aria-describedby="port-help"/);
});

test("standalone controls do not inherit an unrelated field id", () => {
  const html = renderToStaticMarkup(<><FormField><Label>地址</Label><Input /></FormField><Input aria-label="搜索" /></>);
  assert.equal([...html.matchAll(/<input[^>]* id="/g)].length, 1);
  assert.match(html, /aria-label="搜索"/);
});
