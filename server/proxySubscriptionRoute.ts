import express, { type Request, type Response } from "express";

import * as db from "./db";
import {
  formatProxySubscriptionUserInfo,
  normalizeProxySubscriptionFormat,
  PROXY_SUBSCRIPTION_FORMAT_CONTENT_TYPES,
  renderProxySubscription,
  type ProxySubscriptionFormat,
} from "../shared/proxySubscription";

export const proxySubscriptionRouter = express.Router();

/**
 * 各家客户端拉订阅时不会带 format 参数，只能靠 User-Agent 区分。识别不出来时
 * 回落到令牌上配置的默认格式，而不是猜。
 */
function formatFromUserAgent(userAgent: string): ProxySubscriptionFormat | null {
  const ua = userAgent.toLowerCase();
  if (!ua) return null;
  if (ua.includes("clash") || ua.includes("mihomo") || ua.includes("stash")) return "clash";
  if (ua.includes("sing-box") || ua.includes("singbox")) return "singbox";
  if (ua.includes("loon")) return "loon";
  return null;
}

function clientIp(req: Request): string {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.ip || "";
}

/**
 * 客户端订阅地址。
 *
 * 这条路由不走登录态：订阅客户端只会带上地址里的令牌。因此令牌本身就是凭据，
 * 长度和随机性由签发处保证，用户可以随时重置。
 */
proxySubscriptionRouter.get("/api/sub/:token", async (req: Request, res: Response) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!token) {
      res.status(404).type("text/plain").send("订阅不存在");
      return;
    }

    const record = await db.getProxySubTokenByToken(token);
    // 令牌无效与被停用统一返回 404，避免把「这个令牌存在但停用了」的信息泄露出去。
    if (!record || !record.isEnabled) {
      res.status(404).type("text/plain").send("订阅不存在");
      return;
    }
    const expiresAt = record.expiresAt ? new Date(record.expiresAt as any).getTime() : 0;
    if (expiresAt && expiresAt <= Date.now()) {
      res.status(404).type("text/plain").send("订阅不存在");
      return;
    }

    const requested = String(req.query.format || req.query.target || "").trim();
    const format: ProxySubscriptionFormat = requested
      ? normalizeProxySubscriptionFormat(requested)
      : formatFromUserAgent(String(req.headers["user-agent"] || ""))
        ?? normalizeProxySubscriptionFormat(record.defaultFormat);

    const document = await db.getProxySubscriptionDocumentForUser(Number(record.userId));
    const body = renderProxySubscription(document, format);

    const user = await db.getUserById(Number(record.userId));
    if (user) {
      const used = Number(user.trafficUsed || 0);
      const userExpiresAt = user.expiresAt ? new Date(user.expiresAt as any).getTime() : 0;
      res.setHeader(
        "Subscription-Userinfo",
        formatProxySubscriptionUserInfo({
          // 面板只记录总量，没有分上下行的口径，全部计入 download 以免客户端重复累加。
          upload: 0,
          download: used,
          total: Number(user.trafficLimit || 0),
          expire: userExpiresAt ? Math.floor(userExpiresAt / 1000) : 0,
        }),
      );
    }

    res.setHeader("Content-Type", PROXY_SUBSCRIPTION_FORMAT_CONTENT_TYPES[format]);
    res.setHeader("Profile-Update-Interval", "12");
    // 订阅内容随转发增删而变，缓存会让用户以为新建的转发没生效。
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(body);

    // 记录访问失败不应该影响已经发出的订阅内容。
    void db.recordProxySubTokenAccess(Number(record.id), {
      ip: clientIp(req),
      userAgent: String(req.headers["user-agent"] || ""),
    }).catch(() => {});
  } catch (error) {
    console.error("[proxy-subscription] 生成订阅失败:", error);
    res.status(500).type("text/plain").send("订阅生成失败");
  }
});
