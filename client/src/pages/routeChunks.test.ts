import assert from "node:assert/strict";
import test from "node:test";
import { prefetchRoute, routeChunks } from "./routeChunks";

/**
 * 预取还在路上时用户就点了：navigateAfterPrefetch 要等的是**那一次**下载。
 * 原来的实现只记「取过了」，第二次调用回一个已经 resolve 的空 promise，
 * 于是立刻换页，Suspense 照样先转一圈。
 */
test("在路上的预取，再调一次拿到的是同一个 promise，不会提前 resolve", async () => {
  let loads = 0;
  let finish: () => void = () => undefined;
  routeChunks["/__test-inflight"] = () => {
    loads += 1;
    return new Promise<void>((resolve) => { finish = resolve; });
  };
  try {
    const first = prefetchRoute("/__test-inflight");
    const second = prefetchRoute("/__test-inflight");
    assert.ok(first);
    assert.equal(second, first);
    assert.equal(loads, 1);

    let settled = false;
    void second!.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "包还没到就不能算好了");

    finish();
    await second;
    assert.equal(settled, true);
    assert.equal(prefetchRoute("/__test-inflight"), first, "到了以后再调，还是同一个、已经 resolve 的 promise");
    assert.equal(loads, 1);
  } finally {
    delete routeChunks["/__test-inflight"];
  }
});

test("下载失败的那一次会被忘掉，下次预取重新下", async () => {
  let loads = 0;
  routeChunks["/__test-retry"] = () => {
    loads += 1;
    return loads === 1 ? Promise.reject(new Error("offline")) : Promise.resolve();
  };
  try {
    await prefetchRoute("/__test-retry");
    await prefetchRoute("/__test-retry");
    assert.equal(loads, 2);
  } finally {
    delete routeChunks["/__test-retry"];
  }
});

test("没登记的路径不预取", () => {
  assert.equal(prefetchRoute("/__not-a-route"), undefined);
});
