import { createHash } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import type { EnterpriseDocumentBlobStore, EnterprisePageResource } from '@/shared/index.js';

import { inspectDocumentContent } from './document-content.policy.js';
import { chunkUnits, extractDocumentText, unsupportedExtractorName } from './document-extraction.js';
import { createScopedEnterpriseRepository, findActiveEnterpriseMembership, findLiveEnterpriseSessionMember } from './enterprise.repository.js';
import { OPS_REPORT_MAX_SOURCES, OPS_REPORT_RULE_VERSION, isoWeekRange, opsReportResultSha256, runOpsReportV1 } from './ops-report-v1.js';
import { ACC_MATCH_RULE_VERSION, reconciliationResultSha256, runAccMatchV1, type ReconciliationResult } from './reconciliation-acc-match-v1.js';
import { buildReconciliationExport, RECONCILIATION_EXPORT_FORMATS, type ReconciliationExportFormat, type ReconciliationExportSource } from './reconciliation-export.js';

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function requireUuid(value: string) {
  if (!isUuid(value)) throw new Error('ENTERPRISE_INVALID_ID');
}

function requireText(value: string, limit: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) throw new Error('ENTERPRISE_INVALID_TEXT');
  return value.trim();
}

type PageOptions = { limit?: number; cursor?: string };
/** 文件內容來源；content 是伺服器已持有的 bytes，expectedSha256 只作比對。 */
type DocumentContentInput = { filename: string; mediaType: string; content: Buffer; expectedSha256?: string };
/**
 * reserveStorage（ASTRA-006）：在寫 blob 之前、同一個已核對交易內呼叫，負責鎖定並檢查訂閱與儲存配額（去重後新增 bytes）。
 * enterprise-api 路由一律提供；未提供時不做權益檢查（只供底層儲存測試）。
 */
type PersistenceOptions = {
  blobStore?: EnterpriseDocumentBlobStore; maxDocumentBytes?: number;
  reserveStorage?: (client: PoolClient, organizationId: string, blob: { sha256: string; byteSize: number }) => Promise<void>;
  /** 商務寫入前的權益檢查（同一交易內）；未提供時不檢查（模組內部測試）。 */
  checkWrite?: (client: PoolClient, organizationId: string, action: 'reconciliation.create' | 'ops_report.create') => Promise<void>;
  /** V5 可觀測性：確定性引擎純計算耗時（秒），不含 DB／storage。 */
  onEngine?: (engine: 'ops_report' | 'reconciliation' | 'reconciliation_export', seconds: number) => void;
};

const MAX_VERSION_NUMBER = 100000;

function requireVersionNumber(value: unknown, minimum: number) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > MAX_VERSION_NUMBER) throw new Error('ENTERPRISE_INVALID_VERSION');
  return value;
}

function isUniqueViolation(error: unknown) {
  return (error as { code?: unknown } | null)?.code === '23505';
}

function requirePageLimit(options: PageOptions | undefined) {
  if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options)
    || Reflect.ownKeys(options).some(key => key !== 'limit' && key !== 'cursor'))) {
    throw new Error('ENTERPRISE_INVALID_PAGE');
  }
  const limit = options?.limit === undefined ? 50 : options.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('ENTERPRISE_INVALID_PAGE');
  return limit;
}

function pageSort(resource: EnterprisePageResource) {
  return resource === 'audit_events' ? 'occurred_at,id:asc' : 'created_at,id:asc';
}

function readCursor(cursor: string | undefined, organizationId: string, resource: EnterprisePageResource) {
  if (cursor === undefined) return undefined;
  try {
    if (typeof cursor !== 'string' || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) throw new Error();
    const body: unknown = JSON.parse(decoded.toString('utf8'));
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    const value = body as Record<string, unknown>;
    if (Object.keys(value).length !== 5 || value.v !== 1 || !isUuid(value.organizationId)
      || value.organizationId.toLowerCase() !== organizationId.toLowerCase()
      || value.kind !== resource || value.sort !== pageSort(resource) || !isUuid(value.id)) throw new Error();
    return value.id.toLowerCase();
  } catch {
    throw new Error('ENTERPRISE_INVALID_CURSOR');
  }
}

function writeCursor(organizationId: string, resource: EnterprisePageResource, id: string) {
  return Buffer.from(JSON.stringify({ v: 1, organizationId: organizationId.toLowerCase(), kind: resource, sort: pageSort(resource), id })).toString('base64url');
}

/**
 * 供未來企業 auth composition root 與本模組測試使用的內部資料層。
 * resolvePrincipal 必須是伺服器信任的已驗證身分提供器，不能從 request body 產生。
 * 本輪沒有接入 HTTP/WS 或原 SQLite Auth；這不是登入驗證或完整角色 RBAC。
 */
export function createEnterprisePersistence(pool: Pool, resolvePrincipal: () => Promise<{ userAccountId: string; sessionId?: string } | null>, options: PersistenceOptions = {}) {
  return {
    async withOrganization<T>(organizationId: string, operation: (service: ReturnType<typeof createScopedService>) => Promise<T>): Promise<T> {
      requireUuid(organizationId);
      const principal = await resolvePrincipal();
      if (!principal) throw new Error('ENTERPRISE_AUTH_REQUIRED');
      requireUuid(principal.userAccountId);
      const client = await pool.connect();
      let active = true;
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('dhc.organization_id',$1,true)", [organizationId]);
        // HTTP 路徑帶 sessionId：重驗 session epoch（BUILDER-V4-NEW-004）；模組內部呼叫（無 session）維持 membership 檢查。
        const memberId = principal.sessionId
          ? await findLiveEnterpriseSessionMember(client, organizationId, principal.sessionId, principal.userAccountId)
          : await findActiveEnterpriseMembership(client, organizationId, principal.userAccountId);
        if (!memberId) throw new Error(principal.sessionId ? 'ENTERPRISE_AUTH_REQUIRED' : 'ENTERPRISE_SCOPE_DENIED');
        const repository = createScopedEnterpriseRepository(client, organizationId, memberId);
        const result = await operation(createScopedService(repository, organizationId, () => active, options, client));
        active = false;
        await client.query('COMMIT');
        return result;
      } catch (error) {
        active = false;
        await client.query('ROLLBACK');
        throw error;
      } finally {
        active = false;
        client.release();
      }
    },
  };
}

function createScopedService(repository: ReturnType<typeof createScopedEnterpriseRepository>, organizationId: string, isActive: () => boolean, options: PersistenceOptions, client: PoolClient) {
  // storage adapter 只接受小寫 UUID；組織 id 已由 withOrganization 驗證並核對 membership。
  const storageOrganizationId = organizationId.toLowerCase();
  function timed<T>(engine: 'ops_report' | 'reconciliation' | 'reconciliation_export', compute: () => T): T {
    const started = process.hrtime.bigint();
    try {
      return compute();
    } finally {
      options.onEngine?.(engine, Number(process.hrtime.bigint() - started) / 1e9);
    }
  }
  function checkActive() {
    if (!isActive()) throw new Error('ENTERPRISE_SCOPE_CLOSED');
  }
  function requireBlobStore() {
    if (!options.blobStore) throw new Error('ENTERPRISE_BLOB_STORE_UNCONFIGURED');
    return options.blobStore;
  }
  function inspect(input: DocumentContentInput) {
    if (input === null || typeof input !== 'object') throw new Error('ENTERPRISE_DOCUMENT_EMPTY');
    return inspectDocumentContent(input, { maxBytes: options.maxDocumentBytes });
  }
  /**
   * 先寫 blob（內容定址、冪等），再在同一個已核對交易寫 blob/版本 metadata 與 audit。
   * DB 失敗時交易回退；已寫入的 blob 只在本組織目錄、內容已驗 hash，留給後續 GC，不在此刪除。
   */
  async function writeVersion(documentId: string, versionNumber: number, content: Buffer, inspected: ReturnType<typeof inspectDocumentContent>) {
    // ASTRA-006：配額檢查與 blob／版本寫入在同一交易、同一把組織權益鎖下；超額時 blob 尚未寫入。
    await options.reserveStorage?.(client, organizationId, { sha256: inspected.sha256, byteSize: inspected.byteSize });
    checkActive();
    await requireBlobStore().put(storageOrganizationId, inspected.sha256, content);
    checkActive();
    const blobId = await repository.ensureBlob(inspected.sha256, inspected.byteSize);
    try {
      const version = await repository.insertDocumentVersion({ documentId, versionNumber, blobId, filename: inspected.filename, mediaType: inspected.mediaType });
      await repository.appendAudit('document.version_created', 'document', documentId);
      return version;
    } catch (error) {
      if (isUniqueViolation(error)) throw new Error('ENTERPRISE_VERSION_CONFLICT');
      throw error;
    }
  }
  async function readPage<Row extends { id: string }>(resource: EnterprisePageResource, options: PageOptions | undefined,
    selectRows: (rowLimit: number, afterId?: string) => Promise<Row[]>): Promise<{ items: Row[]; nextCursor: string | null }> {
    checkActive();
    const limit = requirePageLimit(options);
    const afterId = readCursor(options?.cursor, organizationId, resource);
    const rows = await selectRows(limit+1, afterId);
    checkActive();
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit ? writeCursor(organizationId, resource, items[items.length-1].id) : null };
  }
  return {
    async listTasks() { checkActive(); return repository.listTasks(); },
    async getTask(id: string) { checkActive(); requireUuid(id); return repository.getTask(id); },
    async listDocuments() { checkActive(); return repository.listDocuments(); },
    async getDocument(id: string) { checkActive(); requireUuid(id); return repository.getDocument(id); },
    async listAuditEvents() { checkActive(); return repository.listAuditEvents(); },
    // Cursor 只定位；此 service 只能由 withOrganization 在已核對的 transaction 內建立。
    async listTasksPage(options?: PageOptions) { return readPage('tasks', options, repository.listTasksPageRows); },
    async listDocumentsPage(options?: PageOptions) { return readPage('documents', options, repository.listDocumentsPageRows); },
    async listAuditEventsPage(options?: PageOptions) { return readPage('audit_events', options, repository.listAuditEventsPageRows); },
    async createTask(input: { title: string }) {
      checkActive();
      const task = await repository.insertTask(requireText(input.title, 500));
      await repository.appendAudit('task.created', 'task', task.id);
      return task;
    },
    async createDocumentWithVersion(input: { title: string; classification?: string } & DocumentContentInput) {
      checkActive();
      requireBlobStore();
      const title = requireText(input.title, 500);
      const classification = requireText(input.classification ?? 'internal', 64);
      const inspected = inspect(input);
      const document = await repository.insertDocument(title, classification);
      await repository.appendAudit('document.created', 'document', document.id);
      const version = await writeVersion(document.id, 1, input.content, inspected);
      return { document, version };
    },
    /** expectedLatestVersion 是呼叫端看到的最新版號（無版本為 0）；與目前不符即 VERSION_CONFLICT，不自動合併。 */
    async addDocumentVersion(documentId: string, input: { expectedLatestVersion: number } & DocumentContentInput) {
      checkActive();
      requireBlobStore();
      requireUuid(documentId);
      const expected = requireVersionNumber(input?.expectedLatestVersion, 0);
      const latest = await repository.readDocumentLatestVersion(documentId);
      // 外組織與不存在的文件同一個錯誤，不洩漏存在性；在任何寫入（含 blob）之前就拒絕。
      if (latest === undefined) throw new Error('ENTERPRISE_DOCUMENT_NOT_FOUND');
      if (latest !== expected) throw new Error('ENTERPRISE_VERSION_CONFLICT');
      if (expected >= MAX_VERSION_NUMBER) throw new Error('ENTERPRISE_INVALID_VERSION');
      const inspected = inspect(input);
      return writeVersion(documentId, expected + 1, input.content, inspected);
    },
    async listDocumentVersions(documentId: string) {
      checkActive();
      requireUuid(documentId);
      if (!(await repository.documentExists(documentId))) throw new Error('ENTERPRISE_DOCUMENT_NOT_FOUND');
      return repository.listDocumentVersions(documentId);
    },
    async getDocumentVersion(documentId: string, versionNumber: number) {
      checkActive();
      requireUuid(documentId);
      return repository.getDocumentVersion(documentId, requireVersionNumber(versionNumber, 1));
    },
    /**
     * W6-B：以 ACC-MATCH-v1 對兩個固定文件版本執行確定性對帳，結果只新增。同輸入的成功結果唯一（重送回 reused）；
     * 拒收也記錄錯誤清單；不呼叫模型、不換匯、不寫任何外部系統。
     */
    async createReconciliation(input: Record<string, unknown>) {
      checkActive();
      const store = requireBlobStore();
      const pick = (value: unknown) => {
        const ref = value as { documentId?: unknown; versionNumber?: unknown } | null;
        if (!ref || typeof ref !== 'object' || typeof ref.documentId !== 'string') throw new Error('ENTERPRISE_INVALID_RECONCILIATION');
        requireUuid(ref.documentId);
        return { documentId: ref.documentId.toLowerCase(), versionNumber: requireVersionNumber(ref.versionNumber, 1) };
      };
      const ledgerRef = pick(input.ledger);
      const receiptsRef = pick(input.receipts);
      const date = (value: unknown) => {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('ENTERPRISE_INVALID_RECONCILIATION');
        return value;
      };
      const periodStart = date(input.periodStart);
      const periodEnd = date(input.periodEnd);
      if (input.ruleVersion !== undefined && input.ruleVersion !== ACC_MATCH_RULE_VERSION) throw new Error('ENTERPRISE_INVALID_RECONCILIATION');
      const load = async (ref: { documentId: string; versionNumber: number }) => {
        const version = await repository.getDocumentVersion(ref.documentId, ref.versionNumber);
        if (!version) throw new Error((await repository.documentExists(ref.documentId)) ? 'ENTERPRISE_VERSION_NOT_FOUND' : 'ENTERPRISE_DOCUMENT_NOT_FOUND');
        const content = await store.get(storageOrganizationId, version.sha256);
        if (createHash('sha256').update(content).digest('hex') !== version.sha256) throw new Error('ENTERPRISE_BLOB_INTEGRITY');
        return { version, content };
      };
      const ledger = await load(ledgerRef);
      const receipts = await load(receiptsRef);
      if (ledger.version.id === receipts.version.id) throw new Error('ENTERPRISE_INVALID_RECONCILIATION');
      await options.checkWrite?.(client, organizationId, 'reconciliation.create');
      const key = { ruleVersion: ACC_MATCH_RULE_VERSION, ledgerVersionId: ledger.version.id, receiptsVersionId: receipts.version.id, periodStart, periodEnd };
      const existing = await repository.findCompletedReconciliation(key);
      if (existing) return { reconciliation: existing, reused: true };
      const result = timed('reconciliation', () => runAccMatchV1({
        ledger: { content: ledger.content, versionId: ledger.version.id, sha256: ledger.version.sha256 },
        receipts: { content: receipts.content, versionId: receipts.version.id, sha256: receipts.version.sha256 }, periodStart, periodEnd,
      }));
      checkActive();
      const { row, reused } = await repository.insertReconciliation({ ...key, ledgerSha256: ledger.version.sha256, receiptsSha256: receipts.version.sha256,
        status: result.status, result, resultSha256: reconciliationResultSha256(result) });
      if (!reused) await repository.appendAudit(`reconciliation.${result.status}`, 'reconciliation', row.id);
      return { reconciliation: row, reused };
    },
    /**
     * V5 OPS-REPORT-v1：以 1–5 個文件版本、ISO 週別與明示案例集產生確定性週報。組織只來自 session（withOrganization）；
     * 來源 bytes 由 storage 讀回並重驗 hash；同輸入（來源版本集合＋案例集＋週別）重送回原結果（reused），並行重送由唯一索引收斂。
     * 撤權／停權：withOrganization 在交易開頭重驗 session epoch；寫入前再檢查商務權益。計算是純函式，不呼叫模型。
     */
    async createOpsReport(input: Record<string, unknown>) {
      checkActive();
      const store = requireBlobStore();
      const invalid = () => new Error('ENTERPRISE_INVALID_OPS_REPORT');
      if (input.ruleVersion !== undefined && input.ruleVersion !== OPS_REPORT_RULE_VERSION) throw invalid();
      if (typeof input.week !== 'string' || !isoWeekRange(input.week)) throw invalid();
      const week = input.week;
      const [periodStart, periodEnd] = isoWeekRange(week)!;
      const datasets = input.datasets;
      if (!Array.isArray(datasets) || !datasets.length || datasets.length > 5 || datasets.some(item => typeof item !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(item))
        || new Set(datasets).size !== datasets.length) throw invalid();
      const refs = input.sources;
      if (!Array.isArray(refs) || !refs.length || refs.length > OPS_REPORT_MAX_SOURCES) throw invalid();
      const loaded = [];
      for (const value of refs) {
        const ref = value as { documentId?: unknown; versionNumber?: unknown } | null;
        if (!ref || typeof ref !== 'object' || typeof ref.documentId !== 'string') throw invalid();
        requireUuid(ref.documentId);
        const documentId = ref.documentId.toLowerCase();
        const version = await repository.getDocumentVersion(documentId, requireVersionNumber(ref.versionNumber, 1));
        if (!version) throw new Error((await repository.documentExists(documentId)) ? 'ENTERPRISE_VERSION_NOT_FOUND' : 'ENTERPRISE_DOCUMENT_NOT_FOUND');
        loaded.push(version);
      }
      // 同一版本列兩次＝請求錯誤；來源依版本 id 排序，讓「同一組來源」不論請求順序都是同一個冪等鍵與同一份結果。
      if (new Set(loaded.map(version => version.id)).size !== loaded.length) throw invalid();
      loaded.sort((a, b) => (a.id < b.id ? -1 : 1));
      const sortedDatasets = [...(datasets as string[])].sort();
      const inputKey = createHash('sha256').update(JSON.stringify({ datasets: sortedDatasets, sources: loaded.map(version => [version.id, version.sha256]) })).digest('hex');
      await options.checkWrite?.(client, organizationId, 'ops_report.create');
      const key = { ruleVersion: OPS_REPORT_RULE_VERSION, isoWeek: week, inputKey };
      const existing = await repository.findCompletedOpsReport(key);
      if (existing) return { opsReport: existing, reused: true };
      const sources: Array<{ content: Buffer; versionId: string; sha256: string }> = [];
      for (const version of loaded) {
        const content = await store.get(storageOrganizationId, version.sha256);
        if (createHash('sha256').update(content).digest('hex') !== version.sha256) throw new Error('ENTERPRISE_BLOB_INTEGRITY');
        sources.push({ content, versionId: version.id, sha256: version.sha256 });
      }
      const result = timed('ops_report', () => runOpsReportV1({ sources, week, datasets: sortedDatasets }));
      checkActive();
      const { row, reused } = await repository.insertOpsReport({ ...key, periodStart, periodEnd, datasets: sortedDatasets, status: result.status, result,
        resultSha256: opsReportResultSha256(result), sources: loaded.map(version => ({ documentVersionId: version.id, sha256: version.sha256 })) });
      if (!reused) await repository.appendAudit(`ops_report.${result.status}`, 'ops_report', row.id);
      return { opsReport: row, reused };
    },
    async getOpsReport(id: string) {
      checkActive();
      requireUuid(id);
      const row = await repository.getOpsReport(id.toLowerCase());
      if (!row) throw new Error('ENTERPRISE_NOT_FOUND');
      return row;
    },
    async listOpsReports() {
      checkActive();
      return repository.listOpsReports();
    },
    async getReconciliation(id: string) {
      checkActive();
      requireUuid(id);
      const row = await repository.getReconciliation(id.toLowerCase());
      if (!row) throw new Error('ENTERPRISE_NOT_FOUND');
      return row;
    },
    /**
     * V5 ACC-MATCH-v1 結構化匯出（json／csv／markdown）。讀取類動作：訂閱到期仍可匯出（資料取得權），但 session 必須仍有效。
     * 匯出前重讀兩個來源 blob 並重驗 hash：來源遺失或損毀 → ENTERPRISE_SOURCE_UNAVAILABLE（不產生匯出、不留紀錄）。
     * 來源已有新版本時照常匯出但明確標示 superseded（結果只對應綁定版本）。每次匯出寫 reconciliation_exports＋稽核事件。
     */
    async exportReconciliation(id: string, format: unknown) {
      checkActive();
      requireUuid(id);
      if (typeof format !== 'string' || !(RECONCILIATION_EXPORT_FORMATS as readonly string[]).includes(format)) throw new Error('ENTERPRISE_INVALID_FORMAT');
      const store = requireBlobStore();
      const row = await repository.getReconciliation(id.toLowerCase());
      if (!row) throw new Error('ENTERPRISE_NOT_FOUND');
      const sources: ReconciliationExportSource[] = [];
      for (const [side, versionId] of [['ledger', row.ledgerVersionId], ['receipts', row.receiptsVersionId]] as const) {
        const version = await repository.getDocumentVersionById(versionId);
        if (!version || version.sha256 !== (side === 'ledger' ? row.ledgerSha256 : row.receiptsSha256)) throw new Error('ENTERPRISE_SOURCE_UNAVAILABLE');
        try {
          const content = await store.get(storageOrganizationId, version.sha256);
          if (createHash('sha256').update(content).digest('hex') !== version.sha256) throw new Error('ENTERPRISE_BLOB_INTEGRITY');
        } catch (error) {
          const code = error instanceof Error ? error.message : '';
          if (code === 'ENTERPRISE_BLOB_NOT_FOUND' || code === 'ENTERPRISE_BLOB_INTEGRITY') throw new Error('ENTERPRISE_SOURCE_UNAVAILABLE');
          throw error;
        }
        sources.push({ side, documentId: version.documentId, versionNumber: version.versionNumber, versionId: version.id, filename: version.filename,
          sha256: version.sha256, latestVersionNumber: version.latestVersionNumber, superseded: version.latestVersionNumber > version.versionNumber });
      }
      const exported = timed('reconciliation_export', () => buildReconciliationExport({ reconciliation: { ...row, result: row.result as ReconciliationResult }, sources }, format as ReconciliationExportFormat));
      checkActive();
      const record = await repository.insertReconciliationExport({ reconciliationId: row.id, format, sha256: exported.sha256, byteSize: exported.content.length,
        sourcesSuperseded: sources.some(source => source.superseded) });
      await repository.appendAudit(`reconciliation.exported_${format}`, 'reconciliation', row.id);
      return { ...exported, exportId: record.id, filename: `reconciliation-${row.id}.${exported.extension}`, sourcesSuperseded: sources.some(source => source.superseded) };
    },
    async listReconciliations() {
      checkActive();
      return repository.listReconciliations();
    },
    /** 內容由 storage adapter 讀回並重算 hash；版本 metadata 與 bytes 一起回傳，呼叫端不需要也拿不到儲存路徑。 */
    async readDocumentVersionContent(documentId: string, versionNumber: number) {
      checkActive();
      const store = requireBlobStore();
      requireUuid(documentId);
      const version = await repository.getDocumentVersion(documentId, requireVersionNumber(versionNumber, 1));
      if (!version) {
        throw new Error((await repository.documentExists(documentId)) ? 'ENTERPRISE_VERSION_NOT_FOUND' : 'ENTERPRISE_DOCUMENT_NOT_FOUND');
      }
      const content = await store.get(storageOrganizationId, version.sha256);
      checkActive();
      return { version, content };
    },
    /**
     * DOC-02：擷取指定版本的文字並建立可引用 chunk。冪等：最新一次為 succeeded/unsupported 時直接回傳；failed 時可重試（最多 20 次）。
     * 擷取失敗不丟例外，而是寫入 failed 紀錄與錯誤代碼，供 UI 顯示與重試。
     */
    async ingestDocumentVersion(documentId: string, versionNumber: number) {
      checkActive();
      const store = requireBlobStore();
      requireUuid(documentId);
      const version = await repository.getDocumentVersion(documentId, requireVersionNumber(versionNumber, 1));
      if (!version) throw new Error((await repository.documentExists(documentId)) ? 'ENTERPRISE_VERSION_NOT_FOUND' : 'ENTERPRISE_DOCUMENT_NOT_FOUND');
      const latest = await repository.latestExtraction(version.id);
      if (latest && latest.status !== 'failed') return { extraction: latest, reused: true };
      const attempt = (latest?.attempt ?? 0) + 1;
      if (attempt > 20) throw new Error('ENTERPRISE_EXTRACTION_RETRY_LIMIT');
      const content = await store.get(storageOrganizationId, version.sha256);
      checkActive();
      let extractor = unsupportedExtractorName(version.mediaType);
      let status: 'succeeded' | 'failed' | 'unsupported' = 'succeeded';
      let errorCode: string | null = null;
      let chunks: Array<{ text: string; textSha256: string; location: Record<string, unknown> }> = [];
      try {
        const result = await extractDocumentText(version.mediaType, content);
        extractor = result.extractor;
        chunks = chunkUnits(result.units).map(chunk => ({ ...chunk, textSha256: createHash('sha256').update(chunk.text).digest('hex') }));
      } catch (error) {
        const code = error instanceof Error && error.message.startsWith('ENTERPRISE_') ? error.message : 'ENTERPRISE_EXTRACTION_FAILED';
        // 無文字層 PDF（掃描檔，不做 OCR）與不支援型別都記為 unsupported，errorCode 區分原因
        status = code === 'ENTERPRISE_EXTRACTION_UNSUPPORTED' || code === 'ENTERPRISE_EXTRACTION_NO_TEXT_LAYER' ? 'unsupported' : 'failed';
        errorCode = code;
      }
      checkActive();
      const extraction = await repository.insertExtraction({ documentVersionId: version.id, attempt, extractor, status, errorCode, chunks });
      await repository.appendAudit(`document.extraction_${status}`, 'document', documentId);
      return { extraction, reused: false };
    },
    /** DOC-02：組織內全文檢索，回傳可驗證引用（文件、版本、chunk、位置、內容 hash）。 */
    async searchDocuments(input: { query: string; limit?: number; includeHistoricalVersions?: boolean }) {
      checkActive();
      const terms = typeof input?.query === 'string' ? [...new Set(input.query.trim().split(/\s+/).filter(Boolean))] : [];
      if (terms.length === 0 || terms.length > 8 || terms.some(term => term.length > 100)) throw new Error('ENTERPRISE_INVALID_QUERY');
      const limit = input.limit === undefined ? 20 : input.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('ENTERPRISE_INVALID_PAGE');
      const rows = await repository.searchChunks(terms, input.includeHistoricalVersions !== true, limit);
      return rows.map(row => ({
        excerpt: row.text, score: row.score,
        citation: { documentId: row.documentId, documentVersionId: row.documentVersionId, versionNumber: row.versionNumber, title: row.title,
          filename: row.filename, chunkId: row.chunkId, chunkIndex: row.chunkIndex, location: row.location, excerptSha256: row.textSha256 },
      }));
    },
    /** DOC-02：以 chunkId 取回引用原文並重算 hash，verified=false 代表資料已被竄改。 */
    async getCitation(chunkId: string) {
      checkActive();
      requireUuid(chunkId);
      const row = await repository.getChunk(chunkId);
      if (!row) throw new Error('ENTERPRISE_NOT_FOUND');
      return {
        text: row.text, verified: createHash('sha256').update(row.text).digest('hex') === row.textSha256,
        citation: { documentId: row.documentId, documentVersionId: row.documentVersionId, versionNumber: row.versionNumber, title: row.title,
          filename: row.filename, chunkId: row.chunkId, chunkIndex: row.chunkIndex, location: row.location, excerptSha256: row.textSha256 },
      };
    },
    async createDocument(input: { title: string; classification?: string }) {
      checkActive();
      const document = await repository.insertDocument(requireText(input.title, 500), requireText(input.classification ?? 'internal', 64));
      await repository.appendAudit('document.created', 'document', document.id);
      return document;
    },
  };
}
