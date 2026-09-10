#!/usr/bin/env node
/**
 * 把各客户端的官方图标下载到面板的数据目录里。
 *
 *   node scripts/fetch-client-logos.mjs            # 下到 /data/clientLogos
 *   node scripts/fetch-client-logos.mjs --dir ./x  # 下到指定目录
 *   node scripts/fetch-client-logos.mjs --only loon,surge
 *
 * 图标下到数据目录而不是提交进仓库：这些是各客户端自己的商标资源，面板本身是
 * 公开分发的（AGPL 仓库 + Release），不该把它们塞进每个人下载的那个包里。
 * 放在数据目录还有个好处 —— 换图不用重新构建，升级也不会被覆盖掉。
 *
 * 开源客户端的图标从各自仓库拉，请按其许可证使用；闭源客户端（Shadowrocket、
 * Surge、Stash、Loon、Quantumult X）走 App Store 的公开 artwork 接口，拿到的是
 * 1024px 官方原图。用不用、怎么用，由面板运营方自己判断。
 */

import fs from "node:fs";
import path from "node:path";

// 开源客户端：直接给仓库里的图标地址。
const REPO_LOGOS = {
  clash: "https://raw.githubusercontent.com/MetaCubeX/mihomo/Meta/docs/logo.png",
  // 仓库里没有独立的 logo 文件，用官方文档站的图标（同一个 SagerNet 项目）。
  singbox: "https://sing-box.sagernet.org/assets/icon.svg",
  hiddify: "https://raw.githubusercontent.com/hiddify/hiddify-app/main/assets/images/logo.svg",
  v2rayng: "https://raw.githubusercontent.com/2dust/v2rayNG/master/V2rayNG/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png",
  nekobox: "https://raw.githubusercontent.com/MatsuriDayo/NekoBoxForAndroid/main/app/src/main/ic_launcher-playstore.png",
  nekoray: "https://raw.githubusercontent.com/MatsuriDayo/nekoray/main/res/public/nekobox.png",
  // v2rayN 仓库里只有 .ico，里面含 256x256，浏览器会自己挑最大那张。
  v2rayn: "https://raw.githubusercontent.com/2dust/v2rayN/master/v2rayN/v2rayN/Resources/NotifyIcon1.ico",
  // Surfboard 没有开源仓库，用官网的 logo。
  surfboard: "https://getsurfboard.com/img/logo.png",
};

// 闭源客户端：App Store 的公开 lookup 接口，按 App ID 取 1024px 官方 artwork。
const APPSTORE_IDS = {
  shadowrocket: "932747118",
  surge: "1442620678",
  stash: "1596063349",
  loon: "1373567447",
  quantumultx: "1443988620",
};

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
}

/**
 * 找出面板真正读取图标的目录。
 *
 * 这一步不能想当然：本地安装的面板把数据放在 /opt/forwardx-panel/data，路径写在
 * .env 的 SQLITE_PATH 里，面板启动时通过 dotenv 加载。而这个脚本是手动跑的、
 * 不会加载 .env —— 只看 process.env 的话会下到 /data，下载全部成功、面板一张
 * 也看不到，两边都不报错。所以这里要主动去读面板的配置。
 */
function readEnvFile(file) {
  try {
    const out = {};
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

function panelRoots() {
  // 依次是：显式指定、脚本自己所在的面板目录、当前目录、默认安装位置。
  const scriptRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  return [process.env.FORWARDX_PANEL_DIR, scriptRoot, process.cwd(), "/opt/forwardx-panel"]
    .filter(Boolean)
    .map((dir) => path.resolve(dir));
}

function resolveDataDir() {
  if (process.env.SQLITE_PATH) {
    return { dir: path.dirname(process.env.SQLITE_PATH), from: "环境变量 SQLITE_PATH" };
  }

  for (const root of panelRoots()) {
    const env = readEnvFile(path.join(root, ".env"));
    if (env.SQLITE_PATH) {
      return { dir: path.dirname(env.SQLITE_PATH), from: `${root}/.env 的 SQLITE_PATH` };
    }
    const configPath = env.DATABASE_CONFIG_PATH || path.join(root, "data", "database.json");
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const sqlitePath = config?.sqlite?.path;
      if (sqlitePath) return { dir: path.dirname(sqlitePath), from: `${configPath} 的 sqlite.path` };
    } catch {
      // 配置不存在或不是 SQLite，继续找下一个候选。
    }
  }

  const fallback = process.platform === "win32" ? path.resolve(process.cwd(), "data") : "/data";
  return { dir: fallback, from: "默认值（没找到面板配置）" };
}

function defaultDir() {
  if (process.env.FORWARDX_CLIENT_LOGO_DIR) {
    return { dir: process.env.FORWARDX_CLIENT_LOGO_DIR, from: "环境变量 FORWARDX_CLIENT_LOGO_DIR" };
  }
  const { dir, from } = resolveDataDir();
  return { dir: path.join(dir, "clientLogos"), from };
}

const explicitDir = flag("dir");
const resolved = explicitDir ? { dir: explicitDir, from: "命令行 --dir" } : defaultDir();
const outDir = path.resolve(resolved.dir);
const only = (flag("only") || "").split(",").map((s) => s.trim()).filter(Boolean);
const wanted = (id) => only.length === 0 || only.includes(id);

async function download(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 按真实字节判断扩展名，不信 URL 里写的。
 *
 * App Store 的 artwork 地址以 .png 结尾，发回来的却是 JPEG —— 存成 .png 的话
 * 服务端会按扩展名发 Content-Type: image/png，遇上严格 CSP 或 nosniff 就不渲染了。
 */
function extensionOf(buffer, fallback = ".png") {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return ".jpg";
  if (buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP") return ".webp";
  if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) return ".ico";
  const head = buffer.subarray(0, 400).toString("utf8").trimStart();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) return ".svg";
  return fallback;
}

async function appStoreArtwork(appId) {
  const res = await fetch(`https://itunes.apple.com/lookup?id=${appId}`);
  if (!res.ok) throw new Error(`lookup HTTP ${res.status}`);
  const data = await res.json();
  const entry = data?.results?.[0];
  if (!entry) throw new Error("App Store 查不到这个 App");
  // artworkUrl512 的文件名里带尺寸，换成 1024 就是官方原图。
  const url = String(entry.artworkUrl512 || entry.artworkUrl100 || "").replace(/\/\d+x\d+bb\./, "/1024x1024bb.");
  if (!url) throw new Error("这个 App 没有 artwork");
  return { buffer: await download(url), name: entry.trackName };
}

fs.mkdirSync(outDir, { recursive: true });
console.log(`图标目录：${outDir}`);
console.log(`来源：${resolved.from}\n`);
if (resolved.from.startsWith("默认值")) {
  console.log("⚠️  没能定位面板的数据目录。如果面板不在默认位置，图标会下到面板读不到的地方。");
  console.log("   请确认后用 --dir 指定，或设置 FORWARDX_PANEL_DIR 指向面板安装目录。\n");
}

let ok = 0;
let failed = 0;

for (const [id, url] of Object.entries(REPO_LOGOS)) {
  if (!wanted(id)) continue;
  try {
    const buffer = await download(url);
    const ext = extensionOf(buffer, path.extname(new URL(url).pathname) || ".png");
    fs.writeFileSync(path.join(outDir, `${id}${ext}`), buffer);
    console.log(`  ✓ ${id}${ext}  ${(buffer.length / 1024).toFixed(1)} KB  ← 上游仓库`);
    ok += 1;
  } catch (error) {
    console.log(`  ✗ ${id}  ${error.message}  (${url})`);
    failed += 1;
  }
}

for (const [id, appId] of Object.entries(APPSTORE_IDS)) {
  if (!wanted(id)) continue;
  try {
    const { buffer, name } = await appStoreArtwork(appId);
    const ext = extensionOf(buffer);
    fs.writeFileSync(path.join(outDir, `${id}${ext}`), buffer);
    console.log(`  ✓ ${id}${ext}  ${(buffer.length / 1024).toFixed(1)} KB  ← App Store「${name}」1024px`);
    ok += 1;
  } catch (error) {
    console.log(`  ✗ ${id}  ${error.message}`);
    failed += 1;
  }
}

console.log(`\n成功 ${ok} 个，失败 ${failed} 个。`);
console.log("刷新面板的「客户端订阅」页面即可看到，不需要重新构建或重启。");
if (failed > 0) {
  console.log("失败的多半是上游改了图标路径，去对应仓库找一下，手动放进上面那个目录即可（文件名用客户端 id）。");
}
