import express, { type Request, type Response } from 'express';
import type { Pool } from 'pg';

import {
  checkEnterpriseEntitlement, createEnterpriseIdentity, createEnterpriseNotifications, createEnterprisePersistence, createEnterpriseWorkflow,
} from '@/modules/enterprise-persistence/index.js';
import type { EnterpriseDocumentBlobStore, EnterprisePrincipal } from '@/shared/index.js';

import {
  createEnterpriseAuth, createFailureLimiter, enterpriseHandler, principalOf, requirePermission, sendEnterpriseError,
} from './enterprise-http.js';

type EnterpriseRouterOptions = {
  pool: Pool;
  blobStore: EnterpriseDocumentBlobStore;
  maxDocumentBytes: number;
  sessionTtlMs?: number;
  secretKey?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** header 值為 percent-encoded UTF-8（瀏覽器 header 不能直接帶中文）；解碼失敗視為格式錯誤。 */
function decodedHeader(req: Request, name: string, required: boolean) {
  const value = req.headers[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.length > 2048) throw new Error('ENTERPRISE_INVALID_HEADER');
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error('ENTERPRISE_INVALID_HEADER');
  }
}

/** Express 5 的 params 可能是陣列；只接受單一字串。 */
function param(req: Request, name: string) {
  const value = req.params[name];
  if (typeof value !== 'string') throw new Error('ENTERPRISE_INVALID_ID');
  return value;
}

function pageOptions(req: Request) {
  const options: { limit?: number; cursor?: string } = {};
  if (req.query.limit !== undefined) options.limit = Number(req.query.limit);
  if (req.query.cursor !== undefined) {
    if (typeof req.query.cursor !== 'string') throw new Error('ENTERPRISE_INVALID_CURSOR');
    options.cursor = req.query.cursor;
  }
  return options;
}

function contentDisposition(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * 供 server 入口在企業模式掛載於 `/api/enterprise/v1` 的路由（IAM-01、DOC-01 對外 API）。
 * 每個受保護端點：Bearer 驗證（每次查資料庫）→ 權限 → 以 session 的組織建立 scoped persistence。
 * 組織 id 只來自已驗證 session，任何 header/body/query 都不能指定組織。
 */
export function createEnterpriseRouter(options: EnterpriseRouterOptions) {
  const identity = createEnterpriseIdentity(options.pool, { sessionTtlMs: options.sessionTtlMs });
  const workflow = createEnterpriseWorkflow(options.pool, { secretKey: options.secretKey });
  const notifications = createEnterpriseNotifications(options.pool);
  const requireAuth = createEnterpriseAuth(token => identity.authenticate(token));
  const loginLimiter = createFailureLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });
  const router = express.Router();
  const json = express.json({ limit: '64kb', type: 'application/json' });
  const raw = (req: Request, res: Response, next: () => void) => {
    express.raw({ type: () => true, limit: options.maxDocumentBytes })(req, res, (error?: unknown) => {
      if (error) {
        const type = (error as { type?: string }).type;
        return sendEnterpriseError(res, new Error(type === 'entity.too.large' ? 'ENTERPRISE_DOCUMENT_TOO_LARGE' : 'ENTERPRISE_INVALID_BODY'));
      }
      next();
    });
  };
  const persistenceFor = (principal: EnterprisePrincipal) => createEnterprisePersistence(
    options.pool, async () => ({ userAccountId: principal.userAccountId, sessionId: principal.sessionId }),
    { blobStore: options.blobStore, maxDocumentBytes: options.maxDocumentBytes,
      reserveStorage: (client, organizationId, blob) => checkEnterpriseEntitlement(client, organizationId, 'document.write', { blob }),
      checkWrite: (client, organizationId, action) => checkEnterpriseEntitlement(client, organizationId, action) });
  const inScope = <T>(res: Response, operation: Parameters<ReturnType<typeof persistenceFor>['withOrganization']>[1]) => {
    const principal = principalOf(res);
    return persistenceFor(principal).withOrganization(principal.organizationId, operation) as Promise<T>;
  };

  router.get('/health/ready', enterpriseHandler(async (_req, res) => {
    await options.pool.query('SELECT 1');
    res.json({ status: 'ready' });
  }));

  // ---- Identity ----
  router.post('/auth/login', json, enterpriseHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const keys = [`ip:${req.ip}`, `account:${String(body.organizationSlug)}:${String(body.email).toLowerCase()}`];
    if (loginLimiter.isBlocked(keys)) throw new Error('ENTERPRISE_RATE_LIMITED');
    try {
      const session = await identity.login({ organizationSlug: body.organizationSlug, email: body.email, password: body.password });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ token: session.token, expiresAt: session.expiresAt.toISOString() });
    } catch (error) {
      if ((error as Error).message === 'ENTERPRISE_INVALID_CREDENTIALS') loginLimiter.recordFailure(keys);
      throw error;
    }
  }));
  router.post('/auth/logout', requireAuth, enterpriseHandler(async (_req, res) => {
    await identity.logout(principalOf(res));
    res.status(204).end();
  }));
  router.get('/identity/me', requireAuth, enterpriseHandler(async (_req, res) => {
    const principal = principalOf(res);
    res.json({
      organizationId: principal.organizationId, memberId: principal.memberId, email: principal.email,
      roles: principal.roles, permissions: principal.permissions, expiresAt: principal.expiresAt.toISOString(),
    });
  }));

  // ---- Members ----
  router.get('/members', requireAuth, requirePermission('members.read'), enterpriseHandler(async (_req, res) => {
    res.json({ items: await identity.listMembers(principalOf(res)) });
  }));
  router.post('/members', requireAuth, requirePermission('members.manage'), json, enterpriseHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.status(201).json(await identity.createMember(principalOf(res), { email: body.email, password: body.password, roles: body.roles }));
  }));
  router.post('/members/:memberId/disable', requireAuth, requirePermission('members.manage'), enterpriseHandler(async (req, res) => {
    res.json(await identity.disableMember(principalOf(res), param(req, 'memberId')));
  }));
  router.post('/members/:memberId/enable', requireAuth, requirePermission('members.manage'), enterpriseHandler(async (req, res) => {
    res.json(await identity.enableMember(principalOf(res), param(req, 'memberId')));
  }));
  router.put('/members/:memberId/roles', requireAuth, requirePermission('members.manage'), json, enterpriseHandler(async (req, res) => {
    res.json(await identity.setMemberRoles(principalOf(res), param(req, 'memberId'), (req.body ?? {}).roles));
  }));

  // ---- Documents ----
  router.get('/documents', requireAuth, requirePermission('documents.read'), enterpriseHandler(async (req, res) => {
    res.json(await inScope(res, service => service.listDocumentsPage(pageOptions(req))));
  }));
  // DOC-02：上傳／新版本後自動擷取（另一個交易）；擷取錯誤只反映在 extraction 狀態，不讓上傳失敗。
  const autoIngest = async (res: Response, documentId: string, versionNumber: number) => {
    try {
      return (await inScope<{ extraction: unknown }>(res, service => service.ingestDocumentVersion(documentId, versionNumber))).extraction;
    } catch (error) {
      console.error('[enterprise-api] auto ingestion failed:', error instanceof Error && error.message.startsWith('ENTERPRISE_') ? error.message : 'unexpected');
      return null;
    }
  };
  router.get('/documents/search', requireAuth, requirePermission('documents.read'), enterpriseHandler(async (req, res) => {
    const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
    res.json({ items: await inScope(res, service => service.searchDocuments({
      query: typeof req.query.q === 'string' ? req.query.q : '', limit, includeHistoricalVersions: req.query.history === 'true' })) });
  }));
  router.get('/citations/:chunkId', requireAuth, requirePermission('documents.read'), enterpriseHandler(async (req, res) => {
    res.json(await inScope(res, service => service.getCitation(param(req, 'chunkId'))));
  }));
  router.post('/documents/:documentId/versions/:versionNumber/ingestions', requireAuth, requirePermission('documents.write'), enterpriseHandler(async (req, res) => {
    if (!/^\d{1,6}$/.test(param(req, 'versionNumber'))) throw new Error('ENTERPRISE_INVALID_VERSION');
    const result = await inScope<{ extraction: unknown; reused: boolean }>(res, service => service.ingestDocumentVersion(param(req, 'documentId'), Number(param(req, 'versionNumber'))));
    res.status(result.reused ? 200 : 201).json(result);
  }));
  router.post('/documents', requireAuth, requirePermission('documents.write'), raw, enterpriseHandler(async (req, res) => {
    await workflow.assertDocumentWrite(principalOf(res));
    const result = await inScope<{ document: { id: string }; version: { versionNumber: number } }>(res, service => service.createDocumentWithVersion({
      title: decodedHeader(req, 'x-dhc-title', true)!,
      classification: decodedHeader(req, 'x-dhc-classification', false),
      filename: decodedHeader(req, 'x-dhc-filename', true)!,
      mediaType: String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(),
      content: req.body as Buffer,
      expectedSha256: decodedHeader(req, 'x-dhc-content-sha256', false),
    }));
    res.status(201).json({ ...result, extraction: await autoIngest(res, result.document.id, result.version.versionNumber) });
  }));
  router.get('/documents/:documentId', requireAuth, requirePermission('documents.read'), enterpriseHandler(async (req, res) => {
    if (!UUID.test(param(req, 'documentId'))) throw new Error('ENTERPRISE_INVALID_ID');
    const result = await inScope<{ document: unknown; versions: unknown[] }>(res, async service => {
      const document = await service.getDocument(param(req, 'documentId'));
      if (!document) throw new Error('ENTERPRISE_DOCUMENT_NOT_FOUND');
      return { document, versions: await service.listDocumentVersions(param(req, 'documentId')) };
    });
    res.json(result);
  }));
  router.post('/documents/:documentId/versions', requireAuth, requirePermission('documents.write'), raw, enterpriseHandler(async (req, res) => {
    const ifMatch = req.headers['if-match'];
    if (typeof ifMatch !== 'string' || !/^"?\d{1,6}"?$/.test(ifMatch)) throw new Error('ENTERPRISE_PRECONDITION_REQUIRED');
    await workflow.assertDocumentWrite(principalOf(res));
    const version = await inScope<{ versionNumber: number }>(res, service => service.addDocumentVersion(param(req, 'documentId'), {
      expectedLatestVersion: Number(ifMatch.replace(/"/g, '')),
      filename: decodedHeader(req, 'x-dhc-filename', true)!,
      mediaType: String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(),
      content: req.body as Buffer,
      expectedSha256: decodedHeader(req, 'x-dhc-content-sha256', false),
    }));
    res.status(201).json({ ...version, extraction: await autoIngest(res, param(req, 'documentId'), version.versionNumber) });
  }));
  router.get('/documents/:documentId/versions', requireAuth, requirePermission('documents.read'), enterpriseHandler(async (req, res) => {
    res.json({ items: await inScope(res, service => service.listDocumentVersions(param(req, 'documentId'))) });
  }));
  router.get('/documents/:documentId/versions/:versionNumber/content', requireAuth, requirePermission('documents.read'), enterpriseHandler(async (req, res) => {
    if (!/^\d{1,6}$/.test(param(req, 'versionNumber'))) throw new Error('ENTERPRISE_INVALID_VERSION');
    const { version, content } = await inScope<{ version: { mediaType: string; filename: string; sha256: string }; content: Buffer }>(res,
      service => service.readDocumentVersionContent(param(req, 'documentId'), Number(param(req, 'versionNumber'))));
    res.setHeader('Content-Type', version.mediaType);
    res.setHeader('Content-Disposition', contentDisposition(version.filename));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-DHC-Content-SHA256', version.sha256);
    res.end(content);
  }));

  // ---- Reconciliation（W6-B：ACC-MATCH-v1 確定性對帳；DEC-W6-SCOPE-01）----
  router.post('/reconciliations', requireAuth, requirePermission('documents.write'), json, enterpriseHandler(async (req, res) => {
    const result = await inScope<{ reconciliation: unknown; reused: boolean }>(res, service => service.createReconciliation((req.body ?? {}) as Record<string, unknown>));
    res.status(result.reused ? 200 : 201).json(result);
  }));
  router.get('/reconciliations', requireAuth, requirePermission('documents.read'), enterpriseHandler(async (_req, res) => {
    res.json({ items: await inScope(res, service => service.listReconciliations()) });
  }));
  router.get('/reconciliations/:reconciliationId', requireAuth, requirePermission('documents.read'), enterpriseHandler(async (req, res) => {
    res.json(await inScope(res, service => service.getReconciliation(param(req, 'reconciliationId'))));
  }));

  // ---- Audit ----
  router.get('/audit-events', requireAuth, requirePermission('audit.read'), enterpriseHandler(async (req, res) => {
    res.json(await inScope(res, service => service.listAuditEventsPage(pageOptions(req))));
  }));

  // ---- Models / Usage / Subscription ----
  router.get('/models/providers', requireAuth, enterpriseHandler(async (_req, res) => { res.json({ items: await workflow.listProviders(principalOf(res)) }); }));
  router.put('/models/providers', requireAuth, requirePermission('models.manage'), json, enterpriseHandler(async (req, res) => {
    res.json(await workflow.upsertProvider(principalOf(res), (req.body ?? {}) as Record<string, unknown>));
  }));
  router.get('/notifications', requireAuth, enterpriseHandler(async (_req, res) => { res.json({ items: await notifications.list(principalOf(res)) }); }));
  router.post('/notifications/:notificationId/read', requireAuth, enterpriseHandler(async (req, res) => {
    res.json(await notifications.markRead(principalOf(res), param(req, 'notificationId')));
  }));
  router.post('/usage/:usageId/reconcile', requireAuth, requirePermission('billing.manage'), json, enterpriseHandler(async (req, res) => {
    res.json(await workflow.reconcileUsage(principalOf(res), param(req, 'usageId'), (req.body ?? {}) as Record<string, unknown>));
  }));
  router.get('/usage', requireAuth, enterpriseHandler(async (_req, res) => { res.json({ items: await workflow.usageSummary(principalOf(res)) }); }));
  router.get('/subscription', requireAuth, requirePermission('billing.read'), enterpriseHandler(async (_req, res) => { res.json(await workflow.subscription(principalOf(res))); }));

  // ---- Runs / Drafts / Approvals ----
  router.post('/runs/draft-generation', requireAuth, requirePermission('tasks.write'), json, enterpriseHandler(async (req, res) => {
    const body = { ...((req.body ?? {}) as Record<string, unknown>), idempotencyKey: req.headers['idempotency-key'] };
    const result = await workflow.createDraftRun(principalOf(res), body);
    res.status(result.reused ? 200 : 202).json(result);
  }));
  router.get('/runs', requireAuth, enterpriseHandler(async (_req, res) => { res.json({ items: await workflow.listRuns(principalOf(res)) }); }));
  router.get('/runs/:runId', requireAuth, enterpriseHandler(async (req, res) => { res.json(await workflow.getRun(principalOf(res), param(req, 'runId'))); }));
  router.get('/runs/:runId/quarantine', requireAuth, enterpriseHandler(async (req, res) => { res.json(await workflow.getQuarantine(principalOf(res), param(req, 'runId'))); }));
  router.post('/runs/:runId/quarantine/release', requireAuth, enterpriseHandler(async (req, res) => { res.json(await workflow.releaseQuarantine(principalOf(res), param(req, 'runId'))); }));
  router.post('/runs/:runId/quarantine/discard', requireAuth, enterpriseHandler(async (req, res) => { res.json(await workflow.discardQuarantine(principalOf(res), param(req, 'runId'))); }));
  router.post('/runs/:runId/cancel', requireAuth, enterpriseHandler(async (req, res) => { res.json(await workflow.cancelRun(principalOf(res), param(req, 'runId'))); }));
  router.get('/drafts', requireAuth, enterpriseHandler(async (_req, res) => { res.json({ items: await workflow.listDrafts(principalOf(res)) }); }));
  router.get('/drafts/:draftId', requireAuth, enterpriseHandler(async (req, res) => { res.json(await workflow.getDraft(principalOf(res), param(req, 'draftId'))); }));
  router.put('/drafts/:draftId', requireAuth, json, enterpriseHandler(async (req, res) => {
    res.json(await workflow.reviseDraft(principalOf(res), param(req, 'draftId'), (req.body ?? {}) as Record<string, unknown>));
  }));
  router.post('/drafts/:draftId/submit', requireAuth, json, enterpriseHandler(async (req, res) => {
    res.status(201).json(await workflow.submitDraft(principalOf(res), param(req, 'draftId'), (req.body ?? {}) as Record<string, unknown>));
  }));
  router.get('/approvals', requireAuth, enterpriseHandler(async (_req, res) => { res.json({ items: await workflow.listPendingApprovals(principalOf(res)) }); }));
  router.get('/approvals/:approvalId', requireAuth, enterpriseHandler(async (req, res) => { res.json(await workflow.getApproval(principalOf(res), param(req, 'approvalId'))); }));
  router.post('/approvals/:approvalId/decision', requireAuth, json, enterpriseHandler(async (req, res) => {
    res.json(await workflow.decideApproval(principalOf(res), param(req, 'approvalId'), (req.body ?? {}) as Record<string, unknown>));
  }));
  router.get('/drafts/:draftId/export', requireAuth, enterpriseHandler(async (req, res) => {
    const exported = await workflow.exportDraft(principalOf(res), param(req, 'draftId'), req.query.format);
    res.setHeader('Content-Type', exported.mediaType);
    res.setHeader('Content-Disposition', contentDisposition(exported.filename));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-DHC-Content-SHA256', exported.sha256);
    res.setHeader('X-DHC-Approval-Id', exported.approvalId);
    res.setHeader('X-DHC-Approved-Revision', String(exported.revision));
    res.end(exported.content);
  }));

  router.use((_req, res) => sendEnterpriseError(res, new Error('ENTERPRISE_NOT_FOUND')));
  return router;
}
