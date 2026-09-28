import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedMobileCorsOrigin } from "./mobileCors";

test("production CORS only allows the fixed Capacitor app origins", () => {
  // Android（androidScheme=http）与 iOS（capacitor scheme）App 的实际源必须一直可用。
  for (const origin of ["http://localhost", "capacitor://localhost", "https://localhost", "ionic://localhost"]) {
    assert.equal(isAllowedMobileCorsOrigin(origin, true), true, origin);
  }
  for (const origin of [
    "http://localhost:3000",
    "https://localhost:8443",
    "http://localhost.evil.example",
    "http://127.0.0.1",
    "https://evil.example",
    "null",
    "",
  ]) {
    assert.equal(isAllowedMobileCorsOrigin(origin, true), false, origin);
  }
});

test("localhost with a port is only allowed outside production", () => {
  assert.equal(isAllowedMobileCorsOrigin("http://localhost:5173", false), true);
  assert.equal(isAllowedMobileCorsOrigin("https://localhost:8100", false), true);
  assert.equal(isAllowedMobileCorsOrigin("http://localhost:5173", true), false);
  assert.equal(isAllowedMobileCorsOrigin("https://evil.example:5173", false), false);
});
