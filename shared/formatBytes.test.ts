import assert from "node:assert/strict";
import test from "node:test";
import { formatBytes } from "./formatBytes";

const KB = 1024, MB = KB * 1024, GB = MB * 1024, TB = GB * 1024, PB = TB * 1024;

test("各档位都按 1024 进制走", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(KB), "1 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(MB), "1 MB");
  assert.equal(formatBytes(GB), "1 GB");
  assert.equal(formatBytes(TB), "1 TB");
  assert.equal(formatBytes(PB), "1 PB");
});

/**
 * 系统设置和插件那两份原来封顶到 MB —— 一个 5 GB 的备份写成「5120.0 MB」。
 * 单位阶梯爬不上去，数字就没法一眼判断大小。
 */
test("大于 MB 要继续往上爬，不能封顶", () => {
  assert.equal(formatBytes(5 * GB), "5 GB", "原来是「5120.0 MB」");
  assert.equal(formatBytes(2 * TB), "2 TB");
});

/**
 * 用户管理那份阶梯只到 TB，1 PB 会取到数组外 —— 界面上直接出现「undefined」。
 * 夹住下标是为了：宁可单位说小了，也不能吐出一个不是数的东西。
 */
test("超出最大单位时夹住，不能显示 undefined", () => {
  assert.equal(formatBytes(PB), "1 PB");
  assert.equal(formatBytes(2048 * PB), "2048 PB");
  assert.ok(!formatBytes(9e30).includes("undefined"));
});

test("尾零去掉，字节不带小数", () => {
  assert.equal(formatBytes(1.5 * GB), "1.5 GB", "不是「1.50 GB」");
  assert.equal(formatBytes(500 * GB), "500 GB");
  assert.equal(formatBytes(999), "999 B", "字节不写成 999.00 B");
});

test("脏值一律 0 B，不把 NaN 显示出去", () => {
  for (const bad of [null, undefined, "", "abc", NaN, Infinity, -Infinity]) {
    assert.equal(formatBytes(bad as any), "0 B", String(bad));
  }
});

/**
 * 负数是上游的数据错误。显示成「0 B」会把错误藏起来，显示成「5 GB」是在撒谎；
 * 照实带上符号，看见的人才知道有东西不对。
 */
test("负数照实带符号，不装作是 0 也不丢掉符号", () => {
  assert.equal(formatBytes(-5 * GB), "-5 GB");
  assert.equal(formatBytes(-512), "-512 B");
});

test("字符串数字也认（接口回来的经常是字符串）", () => {
  assert.equal(formatBytes("1073741824"), "1 GB");
});
