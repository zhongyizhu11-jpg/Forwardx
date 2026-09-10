/**
 * 运行时客户端图标。
 *
 * 图标放在数据目录的 clientLogos/ 下（跟数据库同级），而不是打包进产物：
 * 这些是各客户端自己的商标资源，面板本身是公开分发的（AGPL 仓库 + Release），
 * 不该把它们塞进每个人下载的那个包里。放在数据目录还有个好处 —— 换图不用重新
 * 构建，升级也不会被覆盖掉。
 */

import express, { type Request, type Response } from "express";
import fs from "fs";
import path from "path";

import { PROXY_CLIENT_TARGETS } from "../shared/proxyClientImport";

const EXTENSIONS = [".svg", ".png", ".webp", ".jpg", ".jpeg", ".ico"] as const;

const CONTENT_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

/** 只认已知的客户端 id，杜绝拿这个路由当任意文件读取用。 */
const KNOWN_IDS = new Set(PROXY_CLIENT_TARGETS.map((target) => target.id));

export function clientLogoDir(): string {
  if (process.env.FORWARDX_CLIENT_LOGO_DIR) return process.env.FORWARDX_CLIENT_LOGO_DIR;
  return path.join(resolveDataDir(), "clientLogos");
}

/**
 * 图标目录跟着数据库走。
 *
 * 必须和 scripts/fetch-client-logos.mjs 解析出同一个目录，否则脚本把图标下到
 * 一处、面板去另一处找，两边都不报错，界面上只是永远没有图标。所以除了
 * SQLITE_PATH，也认 database.json —— 它才是安装脚本一定会写的那份配置。
 */
function resolveDataDir(): string {
  if (process.env.SQLITE_PATH) return path.dirname(process.env.SQLITE_PATH);

  const configPath = process.env.DATABASE_CONFIG_PATH || path.resolve(process.cwd(), "data", "database.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const sqlitePath = config?.sqlite?.path;
    if (typeof sqlitePath === "string" && sqlitePath) return path.dirname(sqlitePath);
  } catch {
    // 配置不存在，或用的是 MySQL/PostgreSQL —— 回落到默认数据目录。
  }

  return process.platform === "win32" ? path.resolve(process.cwd(), "data") : "/data";
}

/** 扫一遍目录，返回 { 客户端 id: 扩展名 }。同一个 id 有多个扩展名时按 EXTENSIONS 的顺序取第一个。 */
export function scanClientLogos(dir = clientLogoDir()): Record<string, string> {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // 目录不存在是正常情况：没放图标就用界面内置的图案。
    return {};
  }

  const found: Record<string, string> = {};
  for (const id of KNOWN_IDS) {
    for (const ext of EXTENSIONS) {
      if (names.includes(`${id}${ext}`)) {
        found[id] = ext;
        break;
      }
    }
  }
  return found;
}

export const clientLogoRouter = express.Router();

clientLogoRouter.get("/api/client-logos", (_req: Request, res: Response) => {
  res.json(scanClientLogos());
});

clientLogoRouter.get("/api/client-logos/:id", (req: Request, res: Response) => {
  const id = String(req.params.id || "");
  if (!KNOWN_IDS.has(id)) {
    res.status(404).end();
    return;
  }

  const ext = scanClientLogos()[id];
  if (!ext) {
    res.status(404).end();
    return;
  }

  // 路径由已知 id + 固定扩展名拼出来，不含任何用户输入的路径片段。
  const filePath = path.join(clientLogoDir(), `${id}${ext}`);
  res.type(CONTENT_TYPES[ext] || "application/octet-stream");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.sendFile(filePath, (error) => {
    if (error && !res.headersSent) res.status(404).end();
  });
});
