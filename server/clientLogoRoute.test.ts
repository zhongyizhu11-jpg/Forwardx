import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scanClientLogos } from "./clientLogoRoute";

function withDir(files: string[], run: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-logos-"));
  try {
    for (const name of files) fs.writeFileSync(path.join(dir, name), "x");
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("按客户端 id 扫出图标，扩展名原样返回", () => {
  withDir(["clash.png", "singbox.svg", "loon.webp"], (dir) => {
    assert.deepEqual(scanClientLogos(dir), {
      clash: ".png",
      singbox: ".svg",
      loon: ".webp",
    });
  });
});

test("App Store 拿到的是 JPEG，扩展名得跟着走", () => {
  // artwork 地址以 .png 结尾但发回 JPEG；存成 .png 的话服务端会发错
  // Content-Type，遇上 nosniff 就不渲染了。下载脚本按字节定扩展名，这里要认得。
  withDir(["shadowrocket.jpg", "surge.jpeg"], (dir) => {
    assert.deepEqual(scanClientLogos(dir), {
      shadowrocket: ".jpg",
      surge: ".jpeg",
    });
  });
});

test("目录不存在时返回空对象，不抛错", () => {
  // 绝大多数面板都没放图标，这是默认路径，不该是异常路径。
  assert.deepEqual(scanClientLogos(path.join(os.tmpdir(), "forwardx-no-such-dir-xyz")), {});
});

test("不认识的文件名一律忽略", () => {
  // 这个目录是运营方自己往里放东西的，别的文件不该被当成图标暴露出去。
  withDir(["clash.png", "readme.md", "notes.txt", "../evil.png", "unknownclient.png"], (dir) => {
    assert.deepEqual(scanClientLogos(dir), { clash: ".png" });
  });
});

test("13 个客户端的图标全都认得，含 .ico", () => {
  // 下载脚本按字节定扩展名，实际会产出 svg/png/jpg/ico 四种。少认一种就是
  // 那一格白下载了 —— v2rayN 上游只提供 .ico（内含 256x256）。
  withDir([
    "clash.png", "stash.jpg", "singbox.svg", "loon.jpg", "surge.jpg",
    "quantumultx.jpg", "hiddify.svg", "shadowrocket.jpg", "v2rayng.png",
    "surfboard.png", "nekobox.png", "nekoray.png", "v2rayn.ico",
  ], (dir) => {
    const found = scanClientLogos(dir);
    assert.equal(Object.keys(found).length, 13);
    assert.equal(found.v2rayn, ".ico");
    assert.equal(found.surfboard, ".png");
    assert.equal(found.nekoray, ".png");
  });
});

test("同一个客户端有多个扩展名时取矢量优先", () => {
  // SVG 在任何倍率下都清楚，优先于位图。
  withDir(["clash.png", "clash.svg", "clash.jpg"], (dir) => {
    assert.deepEqual(scanClientLogos(dir), { clash: ".svg" });
  });
});
