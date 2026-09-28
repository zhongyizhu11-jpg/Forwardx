export const COOKIE_NAME = "app_session_id";
export const TEN_DAYS_MS = 1000 * 60 * 60 * 24 * 10;
export const UNAUTHED_ERR_MSG = 'Please login (10001)';
export const NOT_ADMIN_ERR_MSG = 'You do not have required permission (10002)';
export const ACCOUNT_DISABLED_ERR_MSG = '账户已被禁用，请联系管理员';
export const SESSION_REPLACED_ERR_MSG = '账号已在其他地方登录，请重新登录';
/** 按量计费余额不足时写在规则 protocolBlockReason 上的原因；前端据此显示「余额不足」。 */
export const TRAFFIC_BILLING_BALANCE_BLOCK_REASON = "流量计费余额不足，充值后自动恢复";

/*
  单个 tRPC 批量请求最多携带的调用数。服务端据此拒绝超大 batch（批量里的调用是并发执行的，
  不设上限就能一次塞几千次登录尝试），客户端 httpBatchLink 用同一个值拆包，页面上正常的
  并发查询远小于这个数，不会被误拒。
*/
export const TRPC_MAX_BATCH_SIZE = 64;
