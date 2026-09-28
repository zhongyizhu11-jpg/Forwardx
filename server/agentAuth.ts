import type { Request } from "express";
import * as db from "./db";
import { agentTokenFingerprint, parseAgentAuthProof, verifyAgentAuthProofDetails } from "./agentCrypto";
import { recordAuthenticatedAgentActivity } from "./agentActivity";

export const AGENT_AUTH_RESULT_HEADER = "X-ForwardX-Agent-Auth-Result";
export const AGENT_AUTH_RESULT_ACCEPTED = "accepted";
export const AGENT_AUTH_RESULT_REJECTED = "rejected";

let indexedTokens: string[] | null = null;
let tokenByFingerprint = new Map<string, string>();

function tokenCandidateForProof(raw: string, tokens: string[]) {
  const proof = parseAgentAuthProof(raw);
  if (!proof) return null;
  if (indexedTokens !== tokens) {
    indexedTokens = tokens;
    tokenByFingerprint = new Map(tokens.map((token) => [agentTokenFingerprint(token), token]));
  }
  return tokenByFingerprint.get(proof.fingerprint) || null;
}

export function getResolvedAgentToken(req: Request): string | undefined {
  return (req as any).agentToken || undefined;
}

export function hasClocklessAgentAuth(req: Request) {
  return (req as any).agentAuthVersion === "v2";
}

export function hasVerifiedAgentAuthProof(req: Request) {
  return (req as any).agentAuthVersion === "v1" || (req as any).agentAuthVersion === "v2";
}

export function hasSignedAgentAuthAttempt(req: Request) {
  return (req as any).agentSignedAuthAttempted === true;
}

export function getAgentAuthRequestPath(req: Request) {
  const baseUrl = String(req.baseUrl || "").replace(/\/+$/, "");
  const path = String(req.path || "");
  if (!baseUrl) return path || "/";
  if (!path) return baseUrl || "/";
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function getAgentHostFromRequest(
  req: Request,
  options: { recordActivity?: boolean } = {},
) {
  const token = getResolvedAgentToken(req);
  if (!token) return null;
  const host = await db.getHostByAgentToken(token);
  if (host && options.recordActivity !== false) recordAuthenticatedAgentActivity((host as any).id);
  return host;
}

export async function getAgentHostIdentityFromRequest(req: Request) {
  const token = getResolvedAgentToken(req);
  if (!token) return null;
  const host = await db.getAgentAuthHostIdentity(token);
  if (host) recordAuthenticatedAgentActivity((host as any).id);
  return host;
}

export async function getAgentPresenceHostFromRequest(req: Request) {
  const token = getResolvedAgentToken(req);
  if (!token) return null;
  // The presence route must inspect the pre-request liveness state before this
  // request records activity, otherwise it can miss an offline -> online
  // recovery transition and skip runtime reconciliation.
  const identity = await db.getAgentAuthHostIdentity(token);
  if (!identity) return null;
  return db.getHostAgentPresenceById(identity.id);
}

export async function getCandidateAgentTokens() {
  return db.getAgentAuthTokenCandidates();
}

export async function resolveAgentTokenFromAuthorization(
  req: Request,
  bodyText = "",
  nowMs?: number,
  challengeBodyText = bodyText,
) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  const credential = authHeader.substring(7).trim();
  if (!credential) return null;
  if (!credential.startsWith("v1.") && !credential.startsWith("v2.")) return credential;
  (req as any).agentSignedAuthAttempted = true;
  const verify = (tokens: string[]) => {
    const candidate = tokenCandidateForProof(credential, tokens);
    if (!candidate) return null;
    const verified = verifyAgentAuthProofDetails({
      raw: credential,
      candidateTokens: [candidate],
      method: req.method,
      path: getAgentAuthRequestPath(req),
      bodyText: credential.startsWith("v2.") ? challengeBodyText : bodyText,
      nowMs,
    });
    if (verified) (req as any).agentAuthVersion = verified.version;
    return verified?.token || null;
  };
  const token = verify(await getCandidateAgentTokens());
  if (token) return token;
  // 缓存里没有：可能是刚建的 token，重载一次数据库再验。未认证请求能反复触发这里，
  // 所以全局限频，别让它每次都去查库。
  if (!shouldForceReloadAgentTokenCandidates()) return null;
  return verify(await db.getAgentAuthTokenCandidates({ force: true }));
}

const AGENT_TOKEN_FORCED_RELOAD_INTERVAL_MS = 2_000;
let lastForcedAgentTokenReloadAt = 0;

function shouldForceReloadAgentTokenCandidates(now = Date.now()) {
  if (now - lastForcedAgentTokenReloadAt < AGENT_TOKEN_FORCED_RELOAD_INTERVAL_MS) return false;
  lastForcedAgentTokenReloadAt = now;
  return true;
}
