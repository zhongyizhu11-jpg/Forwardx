import express, { type Request, type Response } from "express";

import * as db from "./db";
import {
  formatProxySubscriptionUserInfo,
  normalizeProxySubscriptionFormat,
  PROXY_SUBSCRIPTION_FORMAT_CONTENT_TYPES,
  renderProxySubscription,
  type ProxySubscriptionFormat,
} from "../shared/proxySubscription";
import { normalizeProxyRulePreset } from "../shared/proxyRuleset";

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
  // Surfboard 用 Surge 的配置格式，两者归一。
  if (ua.includes("surge") || ua.includes("surfboard")) return "surge";
  // QX 的 UA 里域名部分是 URL 编码的 "Quantumult%20X"。
  if (ua.includes("quantumult")) return "quantumultx";
  // 下面这些吃通用 base64。不认它们的话会掉到令牌默认格式上 ——
  // 默认设成 Clash 的话，Shadowrocket 会收到一份它读不懂的 Clash YAML。
  if (ua.includes("shadowrocket")) return "base64";
  if (ua.includes("hiddify")) return "base64";
  if (ua.includes("v2rayng") || ua.includes("v2rayn")) return "base64";
  if (ua.includes("nekobox") || ua.includes("nekoray")) return "base64";
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

    // 同一个令牌提供两种订阅：不带 rules 参数是节点订阅，带上才是规则订阅。
    // 这样换一种不必重新签发地址，Loon 这类要自己配分流的客户端也不受影响。
    const rulesParam = String(req.query.rules ?? "").trim().toLowerCase();
    const rulePreset = !rulesParam || rulesParam === "0" || rulesParam === "false"
      ? "off"
      : (rulesParam === "1" || rulesParam === "true"
        ? normalizeProxyRulePreset(record.rulePreset)
        : normalizeProxyRulePreset(rulesParam));

    // 权限是订阅本身的前提：管理员随时可能收回，或者用户超了流量被自动回收。
    // 与令牌无效同样返回 404，不泄露「这个令牌存在但没权限」。
    const owner = await db.getUserById(Number(record.userId));
    if (!owner || (owner.role !== "admin" && !owner.allowProxySubscription)) {
      res.status(404).type("text/plain").send("订阅不存在");
      return;
    }

    const document = await db.getProxySubscriptionDocumentForUser(Number(record.userId), { rulePreset });
    const body = renderProxySubscription(document, format);

    {
      const used = Number(owner.trafficUsed || 0);
      const userExpiresAt = owner.expiresAt ? new Date(owner.expiresAt as any).getTime() : 0;
      res.setHeader(
        "Subscription-Userinfo",
        formatProxySubscriptionUserInfo({
          // 面板只记录总量，没有分上下行的口径，全部计入 download 以免客户端重复累加。
          upload: 0,
          download: used,
          total: Number(owner.trafficLimit || 0),
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
