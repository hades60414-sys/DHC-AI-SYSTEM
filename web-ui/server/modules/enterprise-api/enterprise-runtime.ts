import type { NextFunction, Request, Response } from 'express';
import { Pool } from 'pg';

import { createEnterpriseRunWorker, createLocalDocumentBlobStore } from '@/modules/enterprise-persistence/index.js';

import { sendEnterpriseError } from './enterprise-http.js';
import { createEnterpriseRouter } from './enterprise.routes.js';

const DEFAULT_MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/**
 * 供 server 入口在企業模式使用：依環境變數建立 dhc_app 連線池、本機 blob store 與 `/api/enterprise/v1` 路由。
 * 呼叫前必須已由 resolveDeploymentMode 驗證必要設定存在。
 */
export function createEnterpriseRuntime(env: NodeJS.ProcessEnv) {
  const pool = new Pool({
    host: env.ENTERPRISE_DB_HOST, port: Number(env.ENTERPRISE_DB_PORT || '5432'), database: env.ENTERPRISE_DB_NAME,
    user: 'dhc_app', password: env.ENTERPRISE_DB_PASSWORD, max: Number(env.ENTERPRISE_DB_POOL_MAX || '10'),
    connectionTimeoutMillis: 10_000, statement_timeout: 30_000, idle_in_transaction_session_timeout: 60_000,
  });
  const maxDocumentBytes = env.ENTERPRISE_MAX_DOCUMENT_BYTES ? Number(env.ENTERPRISE_MAX_DOCUMENT_BYTES) : DEFAULT_MAX_DOCUMENT_BYTES;
  const router = createEnterpriseRouter({
    pool, blobStore: createLocalDocumentBlobStore(env.ENTERPRISE_BLOB_ROOT!), maxDocumentBytes,
    sessionTtlMs: env.ENTERPRISE_SESSION_TTL_MS ? Number(env.ENTERPRISE_SESSION_TTL_MS) : undefined,
    secretKey: env.ENTERPRISE_SECRET_KEY,
    metricsToken: env.DHC_METRICS_TOKEN, accessLog: env.ENTERPRISE_ACCESS_LOG !== 'off',
  });
  // RUN-01：同一行程內的持久工作 worker（狀態全在 PostgreSQL，重啟後由 queued/running 狀態續做或逾時清理）。
  const worker = createEnterpriseRunWorker(pool, { secretKey: env.ENTERPRISE_SECRET_KEY });
  if (env.ENTERPRISE_RUN_WORKER !== 'off') worker.start(Number(env.ENTERPRISE_RUN_WORKER_INTERVAL_MS || '1000'));
  return { router, close: async () => { worker.stop(); await pool.end(); } };
}

/**
 * 與 Express 路由比對一致的路徑正規化：百分比解碼、轉小寫（Express 預設不分大小寫）、合併重複斜線。
 * 解碼失敗或含 `.`／`..` 路徑段時回 null（呼叫端以 400 拒絕）。
 */
function normalizeRequestPath(rawPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  const normalized = decoded.toLowerCase().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (normalized.split('/').some(segment => segment === '.' || segment === '..')) return null;
  return normalized;
}

function isApiPath(path: string) {
  return path === '/api' || path.startsWith('/api/');
}

function isEnterpriseApiPath(path: string) {
  return path === '/api/enterprise/v1' || path.startsWith('/api/enterprise/v1/');
}

/**
 * 供 server 入口在企業模式作為第一個 middleware：正規化後屬於 `/api` 但不是 `/api/enterprise/v1` 的請求一律 403（任何 HTTP 方法、
 * 大小寫、百分比編碼、重複斜線或反斜線別名）；無法正規化的路徑 400；`GET /` 導向 `/office`。
 * 這是縱深防禦：企業模式本來就不組裝 legacy router（見 server/index.ts mountLegacyApiRoutes）。
 */
export function enterpriseLegacyGate(req: Request, res: Response, next: NextFunction) {
  const path = normalizeRequestPath(req.path);
  if (path === null) return sendEnterpriseError(res, new Error('ENTERPRISE_INVALID_PATH'));
  if (req.method === 'GET' && path === '/') return res.redirect(302, '/office');
  if (isApiPath(path) && !isEnterpriseApiPath(path)) return sendEnterpriseError(res, new Error('ENTERPRISE_LEGACY_ENTRY_DISABLED'));
  next();
}

/**
 * 供 server 入口在企業路由之後掛載：任何仍未被企業 router 處理、但正規化後屬於 `/api` 的請求（例如 `//api/enterprise/v1/...`）回 404，
 * 不落到靜態檔或 SPA fallback。
 */
export function enterpriseApiFence(req: Request, res: Response, next: NextFunction) {
  const path = normalizeRequestPath(req.path);
  if (path === null || isApiPath(path)) return sendEnterpriseError(res, new Error(path === null ? 'ENTERPRISE_INVALID_PATH' : 'ENTERPRISE_NOT_FOUND'));
  next();
}
