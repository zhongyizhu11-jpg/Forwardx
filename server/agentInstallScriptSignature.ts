import { createHash, createHmac } from "node:crypto";
import type { Request } from "express";
import { resolveAgentTokenFromAuthorization } from "./agentAuth";
import { panelCryptoNowMs } from "./panelClock";

/*
  Agent 自升级会以 root 执行面板下发的 install.sh。脚本里虽然带了二进制的校验和，
  但脚本本身在 http:// 面板上可以被中间人整个替换掉，校验和也就一起被换了。
  这里用发起请求的 Agent 自己的 token 对脚本做 HMAC，Agent 验过再执行；
  中间人没有 token，伪造不出签名。
*/
export const AGENT_INSTALL_SCRIPT_SIGNATURE_HEADER = "X-ForwardX-Script-Signature";
const AGENT_INSTALL_SCRIPT_SIGNATURE_SALT = "forwardx-install-script-signature";

function installScriptSignatureKey(token: string) {
  // 和认证/加密用的 key 做域分离，签名不能被挪去当别的凭据用。
  return createHash("sha256").update(`${token}|${AGENT_INSTALL_SCRIPT_SIGNATURE_SALT}`).digest();
}

export function signAgentInstallScript(token: string, script: string | Buffer) {
  const body = typeof script === "string" ? Buffer.from(script, "utf8") : script;
  return `v1.${createHmac("sha256", installScriptSignatureKey(token)).update(body).digest("hex")}`;
}

/**
 * 请求带了有效的 Agent 认证头时返回脚本签名；匿名请求（首次安装）返回 null。
 * 认证失败也只是不签名：脚本本身是公开的，不需要因此拒绝下载。
 */
export async function installScriptSignatureForRequest(req: Request, script: string, nowMs = panelCryptoNowMs()) {
  const authHeader = String(req.headers.authorization || "");
  if (!authHeader.startsWith("Bearer ")) return null;
  try {
    const token = await resolveAgentTokenFromAuthorization(req, "", nowMs);
    // 只接受签名认证（v1/v2）；裸 token 形式的旧请求不应该拿到签名。
    if (!token || !(req as any).agentAuthVersion) return null;
    return signAgentInstallScript(token, script);
  } catch {
    return null;
  }
}
