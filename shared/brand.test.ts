import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSiteTitle } from "./brand";

test("new installs and legacy default names resolve to NEX", () => {
  for (const value of [undefined, null, "", "  ", "ForwardX", " forwardx ", "FORWARDX", "NEX"]) {
    assert.equal(resolveSiteTitle(value), "NEX");
  }
});

test("administrator-defined names survive the rebrand", () => {
  for (const title of ["我的面板", "ForwardX Community", "NEX 香港"]) {
    assert.equal(resolveSiteTitle(` ${title} `), title);
  }
});
