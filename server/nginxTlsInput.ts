import crypto from "node:crypto";

/*
  Nginx 隧道的证书域名和自定义证书是租户填的，却写进整台主机共用的一份 nginx 配置。
  域名里带 ; { } $ 或换行就能改写配置、PEM 解析不了或私钥和证书对不上，nginx -t 都会
  失败 —— 同机所有租户的 nginx 转发一起卡在旧配置上。所以保存时就严格校验。
*/
const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** 严格的主机名（也接受点分 IPv4，本身就满足标签规则）。不接受通配符、端口、空白与任何 nginx 特殊字符。 */
export function isValidTlsServerName(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 253) return false;
  const labels = text.replace(/\.$/, "").split(".");
  return labels.length > 0 && labels.every((label) => HOSTNAME_LABEL.test(label));
}

/** 证书和私钥都必须能解析，而且私钥必须和证书配对；否则抛出可直接展示的中文错误。 */
export function assertNginxCertificatePair(certPem: string, keyPem: string) {
  let certificate: crypto.X509Certificate;
  try {
    certificate = new crypto.X509Certificate(certPem);
  } catch {
    throw new Error("Nginx 证书无法解析，请粘贴 PEM 格式的证书（-----BEGIN CERTIFICATE-----）");
  }
  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey(keyPem);
  } catch {
    throw new Error("Nginx 私钥无法解析，请粘贴未加密的 PEM 格式私钥");
  }
  if (!certificate.checkPrivateKey(privateKey)) {
    throw new Error("Nginx 私钥与证书不匹配");
  }
}
