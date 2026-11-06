import type { NextFunction, Request, Response } from 'express';

import type { EnterprisePermission, EnterprisePrincipal } from '@/shared/index.js';

import { defaultEnterpriseMetrics, logEnterpriseEvent, type EnterpriseMetrics } from './enterprise-observability.js';

/** 錯誤代碼 → HTTP 狀態。未列出的錯誤一律 500 且不回傳內部訊息。 */
const STATUS: Record<string, number> = {
  ENTERPRISE_AUTH_REQUIRED: 401,
  ENTERPRISE_INVALID_CREDENTIALS: 401,
  ENTERPRISE_CREDENTIAL_IN_URL: 400,
  ENTERPRISE_FORBIDDEN: 403,
  ENTERPRISE_SCOPE_DENIED: 403,
  ENTERPRISE_LEGACY_ENTRY_DISABLED: 403,
  ENTERPRISE_DOCUMENT_NOT_FOUND: 404,
  ENTERPRISE_VERSION_NOT_FOUND: 404,
  ENTERPRISE_MEMBER_NOT_FOUND: 404,
  ENTERPRISE_NOT_FOUND: 404,
  ENTERPRISE_VERSION_CONFLICT: 409,
  ENTERPRISE_IDEMPOTENCY_KEY_REUSED: 409,
  ENTERPRISE_MEMBER_EXISTS: 409,
  ENTERPRISE_LAST_ADMIN: 409,
  ENTERPRISE_PRECONDITION_REQUIRED: 428,
  ENTERPRISE_DOCUMENT_TOO_LARGE: 413,
  ENTERPRISE_DOCUMENT_TYPE_NOT_ALLOWED: 415,
  ENTERPRISE_DOCUMENT_TYPE_MISMATCH: 415,
  ENTERPRISE_RATE_LIMITED: 429,
  ENTERPRISE_SUBSCRIPTION_INACTIVE: 402,
  ENTERPRISE_SEAT_LIMIT: 403,
  ENTERPRISE_RUN_LIMIT: 429,
  ENTERPRISE_STORAGE_LIMIT: 413,
  ENTERPRISE_PROVIDER_NOT_FOUND: 404,
  ENTERPRISE_DRAFT_LOCKED: 409,
  ENTERPRISE_DRAFT_NOT_APPROVED: 409,
  ENTERPRISE_APPROVAL_ALREADY_DECIDED: 409,
  ENTERPRISE_APPROVAL_STALE: 409,
  ENTERPRISE_SELF_APPROVAL_FORBIDDEN: 403,
  ENTERPRISE_RUN_NOT_CANCELLABLE: 409,
  ENTERPRISE_RUN_NOT_QUARANTINED: 409,
  ENTERPRISE_CITATION_INVALID: 409,
  ENTERPRISE_USAGE_ALREADY_RECONCILED: 409,
  ENTERPRISE_USAGE_IN_FLIGHT: 409,
  ENTERPRISE_SOURCE_UNAVAILABLE: 409,
  ENTERPRISE_REQUEST_ABORTED: 409,
  ENTERPRISE_OPS_REPORT_TOO_LARGE: 413,
  ENTERPRISE_PRINCIPAL_REVOKED: 409,
  ENTERPRISE_SECRET_KEY_UNCONFIGURED: 503,
  ENTERPRISE_EGRESS_DENIED: 403,
  ENTERPRISE_EGRESS_REDIRECT_DENIED: 403,
  ENTERPRISE_EGRESS_POLICY_INVALID: 500,
  ENTERPRISE_BLOB_INTEGRITY: 500,
};
const BAD_REQUEST = /^ENTERPRISE_(INVALID_[A-Z_]+|DOCUMENT_EMPTY|DOCUMENT_HASH_MISMATCH|DOCUMENT_INVALID_FILENAME|WEAK_PASSWORD|IDEMPOTENCY_KEY_REQUIRED)$/;

const MESSAGES: Record<number, string> = {
  400: '請求格式不正確', 401: '需要重新登入', 403: '沒有權限執行此操作', 404: '找不到資源', 409: '資料狀態衝突，請重新整理後再試',
  402: '訂閱未生效或已到期，目前為唯讀', 503: '服務設定不完整', 413: '檔案或儲存空間超過上限', 415: '不支援的檔案類型或內容與類型不符', 428: '缺少必要的版本前提', 429: '嘗試次數過多，請稍後再試', 500: '伺服器發生錯誤',
};

/** 供 enterprise-api 路由統一輸出錯誤：`{ error: { code, message } }`。 */
export function sendEnterpriseError(res: Response, error: unknown) {
  const code = error instanceof Error && error.message.startsWith('ENTERPRISE_') ? error.message : 'ENTERPRISE_INTERNAL';
  const status = STATUS[code] ?? (BAD_REQUEST.test(code) ? 400 : 500);
  // 只記錄錯誤類別與 driver 代碼，不記錄訊息本文（可能含連線字串或使用者輸入）。
  const metrics = (res.locals?.enterpriseMetrics as EnterpriseMetrics | undefined) ?? defaultEnterpriseMetrics;
  // 錯誤代碼是程式內定義的有限集合；格式不符者歸 ENTERPRISE_OTHER，避免任意字串成為標籤。
  metrics.count('errors', { code: /^ENTERPRISE_[A-Z_]{1,48}$/.test(code) ? code : 'ENTERPRISE_OTHER' });
  if (status === 500 && code === 'ENTERPRISE_INTERNAL') {
    // 只記錄錯誤類型、SQLSTATE 與 schema 層級的約束／資料表名稱（不含訊息內容、參數或資料值）
    const meta = error as { code?: unknown; constraint?: unknown; table?: unknown };
    logEnterpriseEvent('enterprise.unexpected_error', {
      request_id: res.locals?.requestId, error_name: error instanceof Error ? error.name : typeof error, sqlstate: typeof meta?.code === 'string' ? meta.code : undefined,
      constraint: typeof meta?.constraint === 'string' ? meta.constraint : undefined, table: typeof meta?.table === 'string' ? meta.table : undefined,
    }, 'error');
  } else if (status === 500) {
    logEnterpriseEvent('enterprise.server_error', { request_id: res.locals?.requestId, code }, 'error');
  }
  res.status(status).json({ error: { code: status === 500 && code !== 'ENTERPRISE_BLOB_INTEGRITY' ? 'ENTERPRISE_INTERNAL' : code, message: MESSAGES[status] } });
}

/** 供 enterprise-api 路由包裝 async handler，所有拋出都走 sendEnterpriseError。 */
export function enterpriseHandler(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => { handler(req, res).catch(error => sendEnterpriseError(res, error)); };
}

/** 供 enterprise-api 路由取得已驗證主體；未經 requireEnterpriseAuth 時丟 AUTH_REQUIRED。 */
export function principalOf(res: Response): EnterprisePrincipal {
  const principal = res.locals.enterprisePrincipal as EnterprisePrincipal | undefined;
  if (!principal) throw new Error('ENTERPRISE_AUTH_REQUIRED');
  return principal;
}

/**
 * 供 enterprise-api 掛在每個受保護路由：只接受 `Authorization: Bearer <token>`；
 * URL query 中出現任何憑證參數直接 400（不嘗試使用）；token 每次請求都向資料庫重新驗證（撤權即時生效）。
 */
export function createEnterpriseAuth(authenticate: (token: string) => Promise<EnterprisePrincipal | null>) {
  return (req: Request, res: Response, next: NextFunction) => {
    for (const key of ['token', 'access_token', 'apiKey', 'api_key', 'auth']) {
      if (key in req.query) return sendEnterpriseError(res, new Error('ENTERPRISE_CREDENTIAL_IN_URL'));
    }
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9._-]{1,512})$/.exec(header) : null;
    if (!match) return sendEnterpriseError(res, new Error('ENTERPRISE_AUTH_REQUIRED'));
    authenticate(match[1]).then(principal => {
      if (!principal) return sendEnterpriseError(res, new Error('ENTERPRISE_AUTH_REQUIRED'));
      res.locals.enterprisePrincipal = principal;
      res.setHeader('Cache-Control', 'no-store');
      next();
    }).catch(error => sendEnterpriseError(res, error));
  };
}

/** 供 enterprise-api 路由宣告所需權限；權限只看伺服器推導的 principal.permissions。 */
export function requirePermission(permission: EnterprisePermission) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!principalOf(res).permissions.includes(permission)) throw new Error('ENTERPRISE_FORBIDDEN');
      next();
    } catch (error) {
      sendEnterpriseError(res, error);
    }
  };
}

/**
 * 供 enterprise-api 登入路由使用的記憶體限流：同一 key 在視窗內失敗達上限即 429（成功不清除其他 key）。
 * 單一實例部署適用；多實例需改共享儲存（DELIVERY 範圍）。
 */
export function createFailureLimiter(options: { limit: number; windowMs: number; now?: () => number }) {
  const failures = new Map<string, number[]>();
  const now = options.now ?? Date.now;
  const recent = (key: string) => (failures.get(key) ?? []).filter(time => now() - time < options.windowMs);
  return {
    isBlocked(keys: string[]) { return keys.some(key => recent(key).length >= options.limit); },
    recordFailure(keys: string[]) {
      for (const key of keys) failures.set(key, [...recent(key), now()]);
      if (failures.size > 10_000) for (const [key] of failures) { if (recent(key).length === 0) failures.delete(key); }
    },
  };
}
