import type { PoolClient } from 'pg';

import type { EnterpriseTaskRow, EnterpriseDocumentRow, EnterpriseAuditEventRow, EnterprisePageResource, EnterpriseDocumentVersionRow, EnterpriseReconciliationRow } from '@/shared/index.js';

const taskColumns = 'id, organization_id AS "organizationId", owner_member_id AS "ownerMemberId", title, status, created_at AS "createdAt", updated_at AS "updatedAt"';
const documentColumns = 'id, organization_id AS "organizationId", owner_member_id AS "ownerMemberId", title, classification, created_at AS "createdAt", updated_at AS "updatedAt"';
const auditColumns = 'id,organization_id AS "organizationId",actor_member_id AS "actorMemberId",action,resource_type AS "resourceType",resource_id AS "resourceId",occurred_at AS "occurredAt"';
// 版本投影一律 JOIN 同組織的 blob；byte_size 為 bigint，pg 預設回字串，此處轉 int（上限 100 MiB，安全）。
const versionColumns = `v.id, v.organization_id AS "organizationId", v.document_id AS "documentId", v.version_number AS "versionNumber",
  v.filename, v.media_type AS "mediaType", b.byte_size::int AS "byteSize", b.sha256, v.created_by_member_id AS "createdByMemberId", v.created_at AS "createdAt"`;
const reconciliationSummaryColumns = `id, rule_version AS "ruleVersion", ledger_version_id AS "ledgerVersionId", receipts_version_id AS "receiptsVersionId",
  ledger_sha256 AS "ledgerSha256", receipts_sha256 AS "receiptsSha256", to_char(period_start,'YYYY-MM-DD') AS "periodStart", to_char(period_end,'YYYY-MM-DD') AS "periodEnd",
  status, result_sha256 AS "resultSha256", created_by_member_id AS "createdByMemberId", created_at AS "createdAt"`;
const reconciliationColumns = `${reconciliationSummaryColumns}, result`;
const versionFrom = `enterprise.document_versions v JOIN enterprise.document_blobs b ON (b.organization_id,b.id)=(v.organization_id,v.blob_id)`;
const extractionColumns = `id, organization_id AS "organizationId", document_version_id AS "documentVersionId", attempt, extractor, status,
  error_code AS "errorCode", chunk_count AS "chunkCount", created_at AS "createdAt"`;
type ExtractionRow = { id: string; organizationId: string; documentVersionId: string; attempt: number; extractor: string;
  status: 'succeeded' | 'failed' | 'unsupported'; errorCode: string | null; chunkCount: number; createdAt: Date };
type SearchRow = { chunkId: string; text: string; textSha256: string; location: Record<string, unknown>; chunkIndex: number;
  documentId: string; documentVersionId: string; versionNumber: number; filename: string; title: string; score: number };

/**
 * RISK-SESSION-INFLIGHT（BUILDER-V4-NEW-004）：在寫入交易內重驗「這個 session」仍有效——未撤銷、未過期、session 的 auth_epoch
 * 等於成員目前 epoch（停權、改角色都會 +1）、成員／帳號／組織 active。FOR SHARE 鎖成員列，與停權／改角色（UPDATE auth_epoch）序列化：
 * 降權若在認證之後、本交易之前提交，這裡看得到並拒絕；若在本交易進行中發生，降權交易等本交易提交後才生效（合法先後順序）。
 * 回傳 member id；session 失效回 undefined（呼叫端回 ENTERPRISE_AUTH_REQUIRED）。
 */
export async function findLiveEnterpriseSessionMember(client: PoolClient, organizationId: string, sessionId: string, userAccountId: string) {
  const result = await client.query<{ id: string }>(
    `SELECT m.id FROM enterprise.auth_sessions s
     JOIN enterprise.org_members m ON (m.organization_id,m.id)=(s.organization_id,s.org_member_id)
     JOIN enterprise.user_accounts u ON (u.organization_id,u.id)=(m.organization_id,m.user_account_id)
     JOIN enterprise.organizations o ON o.id=m.organization_id
     WHERE s.organization_id=$1 AND s.id=$2 AND u.id=$3 AND s.revoked_at IS NULL AND s.expires_at > now() AND s.member_auth_epoch=m.auth_epoch
       AND m.status='active' AND u.status='active' AND o.status='active'
     FOR SHARE OF m`,
    [organizationId, sessionId, userAccountId],
  );
  return result.rowCount === 1 ? result.rows[0].id : undefined;
}

/** 供同模組 enterprise.service 核對可信 principal；只能在已設定候選 org scope 的 transaction 內呼叫。 */
export async function findActiveEnterpriseMembership(client: PoolClient, organizationId: string, userAccountId: string) {
  const result = await client.query<{ id: string }>(
    `SELECT m.id FROM enterprise.org_members m
     JOIN enterprise.user_accounts u ON (u.organization_id,u.id)=(m.organization_id,m.user_account_id)
     JOIN enterprise.organizations o ON o.id=m.organization_id
     WHERE m.organization_id=$1 AND u.id=$2 AND m.status='active' AND u.status='active' AND o.status='active'`,
    [organizationId, userAccountId],
  );
  return result.rowCount === 1 ? result.rows[0].id : undefined;
}

/** 只由同模組 enterprise.service 在已核對 scope 的同一個 transaction client 中建立；不公開 raw client。 */
export function createScopedEnterpriseRepository(client: PoolClient, organizationId: string, memberId: string) {
  async function selectPageRows<Row extends { id: string }>(resource: EnterprisePageResource, columns: string, rowLimit: number, afterId?: string): Promise<Row[]> {
    // identifiers 只能來自下方三個固定 wrapper，絕不從 Cursor 或 request 取表名／欄名。
    const clock = resource === 'audit_events' ? 'occurred_at' : 'created_at';
    const projectedClock = resource === 'audit_events' ? 'occurredAt' : 'createdAt';
    if (afterId === undefined) {
      return (await client.query<Row>(`SELECT ${columns} FROM enterprise.${resource}
        WHERE organization_id=$1 ORDER BY ${clock},id LIMIT $2`, [organizationId, rowLimit])).rows;
    }
    // anchor 與 rows 同一 statement snapshot，保留 PG 微秒精度；已刪除／外組織 anchor 不可見。
    const result = await client.query<Row | { id: null }>(`
      WITH anchor AS (
        SELECT ${clock} AS position_time,id AS position_id FROM enterprise.${resource}
        WHERE organization_id=$1 AND id=$2
      )
      SELECT page.* FROM anchor LEFT JOIN LATERAL (
        SELECT ${columns} FROM enterprise.${resource}
        WHERE organization_id=$1 AND (${clock},id) > (anchor.position_time,anchor.position_id)
        ORDER BY ${clock},id LIMIT $3
      ) AS page ON true ORDER BY page."${projectedClock}",page.id`, [organizationId, afterId, rowLimit]);
    if (result.rows.length === 0) throw new Error('ENTERPRISE_INVALID_CURSOR');
    // id 為 NOT NULL；LEFT JOIN 的 null sentinel 表示 anchor 存在但已到末尾。
    return result.rows.filter((row): row is Row => row.id !== null);
  }
  return {
    async listTasksPageRows(rowLimit: number, afterId?: string) {
      return selectPageRows<EnterpriseTaskRow>('tasks', taskColumns, rowLimit, afterId);
    },
    async listDocumentsPageRows(rowLimit: number, afterId?: string) {
      return selectPageRows<EnterpriseDocumentRow>('documents', documentColumns, rowLimit, afterId);
    },
    async listAuditEventsPageRows(rowLimit: number, afterId?: string) {
      return selectPageRows<EnterpriseAuditEventRow>('audit_events', auditColumns, rowLimit, afterId);
    },
    async listTasks() {
      return (await client.query<EnterpriseTaskRow>(`SELECT ${taskColumns} FROM enterprise.tasks WHERE organization_id=$1 ORDER BY created_at,id LIMIT 100`, [organizationId])).rows;
    },
    async getTask(id: string) {
      return (await client.query<EnterpriseTaskRow>(`SELECT ${taskColumns} FROM enterprise.tasks WHERE organization_id=$1 AND id=$2`, [organizationId, id])).rows[0];
    },
    async insertTask(title: string) {
      return (await client.query<EnterpriseTaskRow>(`INSERT INTO enterprise.tasks(organization_id,owner_member_id,title) VALUES ($1,$2,$3) RETURNING ${taskColumns}`, [organizationId, memberId, title])).rows[0];
    },
    async listDocuments() {
      return (await client.query<EnterpriseDocumentRow>(`SELECT ${documentColumns} FROM enterprise.documents WHERE organization_id=$1 ORDER BY created_at,id LIMIT 100`, [organizationId])).rows;
    },
    async getDocument(id: string) {
      return (await client.query<EnterpriseDocumentRow>(`SELECT ${documentColumns} FROM enterprise.documents WHERE organization_id=$1 AND id=$2`, [organizationId, id])).rows[0];
    },
    async insertDocument(title: string, classification: string) {
      return (await client.query<EnterpriseDocumentRow>(`INSERT INTO enterprise.documents(organization_id,owner_member_id,title,classification) VALUES ($1,$2,$3,$4) RETURNING ${documentColumns}`, [organizationId, memberId, title, classification])).rows[0];
    },
    /**
     * 同組織內回傳文件目前最新版本號（無版本為 0）；文件不在此組織時回 undefined。
     * 不加 row lock（runtime 沒有 UPDATE 權限，FOR SHARE 會被拒）；並行新增同版本號由 UNIQUE(organization_id,document_id,version_number) 決勝。
     */
    async readDocumentLatestVersion(documentId: string) {
      const result = await client.query<{ latest: number }>(
        `SELECT coalesce((SELECT max(version_number) FROM enterprise.document_versions WHERE organization_id=$1 AND document_id=d.id),0)::int AS latest
         FROM enterprise.documents d WHERE d.organization_id=$1 AND d.id=$2`, [organizationId, documentId]);
      return result.rowCount === 1 ? result.rows[0].latest : undefined;
    },
    /** 同組織內依 sha256 取得或建立 blob metadata；不同組織永遠不共用。 */
    async ensureBlob(sha256: string, byteSize: number) {
      await client.query('INSERT INTO enterprise.document_blobs(organization_id,sha256,byte_size) VALUES ($1,$2,$3) ON CONFLICT (organization_id,sha256) DO NOTHING', [organizationId, sha256, byteSize]);
      return (await client.query<{ id: string }>('SELECT id FROM enterprise.document_blobs WHERE organization_id=$1 AND sha256=$2', [organizationId, sha256])).rows[0].id;
    },
    async insertDocumentVersion(input: { documentId: string; versionNumber: number; blobId: string; filename: string; mediaType: string }) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO enterprise.document_versions(organization_id,document_id,version_number,blob_id,filename,media_type,created_by_member_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [organizationId, input.documentId, input.versionNumber, input.blobId, input.filename, input.mediaType, memberId]);
      return (await client.query<EnterpriseDocumentVersionRow>(`SELECT ${versionColumns} FROM ${versionFrom} WHERE v.organization_id=$1 AND v.id=$2`, [organizationId, inserted.rows[0].id])).rows[0];
    },
    async listDocumentVersions(documentId: string) {
      return (await client.query<EnterpriseDocumentVersionRow>(`SELECT ${versionColumns} FROM ${versionFrom} WHERE v.organization_id=$1 AND v.document_id=$2 ORDER BY v.version_number`, [organizationId, documentId])).rows;
    },
    async getDocumentVersion(documentId: string, versionNumber: number) {
      return (await client.query<EnterpriseDocumentVersionRow>(`SELECT ${versionColumns} FROM ${versionFrom} WHERE v.organization_id=$1 AND v.document_id=$2 AND v.version_number=$3`, [organizationId, documentId, versionNumber])).rows[0];
    },
    /** DOC-02：該版本最新一次擷取（含失敗），供冪等與重試判斷。 */
    async latestExtraction(documentVersionId: string) {
      return (await client.query<ExtractionRow>(`SELECT ${extractionColumns} FROM enterprise.document_extractions
        WHERE organization_id=$1 AND document_version_id=$2 ORDER BY attempt DESC LIMIT 1`, [organizationId, documentVersionId])).rows[0];
    },
    async insertExtraction(input: { documentVersionId: string; attempt: number; extractor: string; status: string; errorCode: string | null;
      chunks: Array<{ text: string; textSha256: string; location: Record<string, unknown> }> }) {
      const extraction = (await client.query<ExtractionRow>(`INSERT INTO enterprise.document_extractions
        (organization_id,document_version_id,attempt,extractor,status,error_code,chunk_count,created_by_member_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${extractionColumns}`,
      [organizationId, input.documentVersionId, input.attempt, input.extractor, input.status, input.errorCode, input.chunks.length, memberId])).rows[0];
      for (const [index, chunk] of input.chunks.entries()) {
        await client.query(`INSERT INTO enterprise.document_chunks(organization_id,extraction_id,document_version_id,chunk_index,text,text_sha256,location)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [organizationId, extraction.id, input.documentVersionId, index, chunk.text, chunk.textSha256, JSON.stringify(chunk.location)]);
      }
      return extraction;
    },
    /**
     * DOC-02 檢索：所有詞都必須出現（strpos，不用 LIKE，無萬用字元注入）；只用每個版本最新的成功擷取。
     * latestOnly=true 時只查每份文件的最新版本。分數＝各詞出現次數總和。
     */
    async searchChunks(terms: string[], latestOnly: boolean, limit: number) {
      const filters = terms.map((_, index) => `strpos(lower(c.text), lower($${index + 4})) > 0`).join(' AND ');
      const score = terms.map((_, index) => `(length(c.text) - length(replace(lower(c.text), lower($${index + 4}), ''))) / greatest(length($${index + 4}),1)`).join(' + ');
      return (await client.query<SearchRow>(`
        SELECT c.id AS "chunkId", c.text, c.text_sha256 AS "textSha256", c.location, c.chunk_index AS "chunkIndex",
          v.document_id AS "documentId", v.id AS "documentVersionId", v.version_number AS "versionNumber", v.filename,
          d.title, (${score})::int AS score
        FROM enterprise.document_chunks c
        JOIN enterprise.document_extractions e ON (e.organization_id,e.id)=(c.organization_id,c.extraction_id)
        JOIN enterprise.document_versions v ON (v.organization_id,v.id)=(c.organization_id,c.document_version_id)
        JOIN enterprise.documents d ON (d.organization_id,d.id)=(v.organization_id,v.document_id)
        WHERE c.organization_id=$1 AND e.status='succeeded'
          AND e.attempt = (SELECT max(e2.attempt) FROM enterprise.document_extractions e2
            WHERE e2.organization_id=$1 AND e2.document_version_id=v.id AND e2.status='succeeded')
          AND ($2::boolean = false OR v.version_number = (SELECT max(v2.version_number) FROM enterprise.document_versions v2
            WHERE v2.organization_id=$1 AND v2.document_id=v.document_id))
          AND ${filters}
        ORDER BY score DESC, d.created_at, v.version_number, c.chunk_index LIMIT $3`, [organizationId, latestOnly, limit, ...terms])).rows;
    },
    async getChunk(chunkId: string) {
      return (await client.query<SearchRow>(`
        SELECT c.id AS "chunkId", c.text, c.text_sha256 AS "textSha256", c.location, c.chunk_index AS "chunkIndex",
          v.document_id AS "documentId", v.id AS "documentVersionId", v.version_number AS "versionNumber", v.filename, d.title, 0 AS score
        FROM enterprise.document_chunks c
        JOIN enterprise.document_versions v ON (v.organization_id,v.id)=(c.organization_id,c.document_version_id)
        JOIN enterprise.documents d ON (d.organization_id,d.id)=(v.organization_id,v.document_id)
        WHERE c.organization_id=$1 AND c.id=$2`, [organizationId, chunkId])).rows[0];
    },
    async documentExists(documentId: string) {
      return (await client.query('SELECT 1 FROM enterprise.documents WHERE organization_id=$1 AND id=$2', [organizationId, documentId])).rowCount === 1;
    },
    /**
     * W6-B：寫入一筆對帳結果（只新增）。成功結果以部分唯一索引保證同輸入只有一筆；並行重送以 ON CONFLICT 取回既有列，
     * 不會撞唯一約束成 500（ASTRA-V3-NEW-003 的教訓）。回傳 { row, reused }。
     */
    async insertReconciliation(input: { ruleVersion: string; ledgerVersionId: string; receiptsVersionId: string; ledgerSha256: string; receiptsSha256: string;
      periodStart: string; periodEnd: string; status: 'completed' | 'rejected'; result: unknown; resultSha256: string }) {
      const values = [organizationId, input.ruleVersion, input.ledgerVersionId, input.receiptsVersionId, input.ledgerSha256, input.receiptsSha256,
        input.periodStart, input.periodEnd, input.status, JSON.stringify(input.result), input.resultSha256, memberId];
      const inserted = (await client.query<EnterpriseReconciliationRow>(`INSERT INTO enterprise.reconciliations(organization_id,rule_version,ledger_version_id,receipts_version_id,
          ledger_sha256,receipts_sha256,period_start,period_end,status,result,result_sha256,created_by_member_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (organization_id, ledger_version_id, receipts_version_id, rule_version, period_start, period_end) WHERE status = 'completed' DO NOTHING
        RETURNING ${reconciliationColumns}`, values)).rows[0];
      if (inserted) return { row: inserted, reused: false };
      const existing = (await client.query<EnterpriseReconciliationRow>(`SELECT ${reconciliationColumns} FROM enterprise.reconciliations
        WHERE organization_id=$1 AND rule_version=$2 AND ledger_version_id=$3 AND receipts_version_id=$4 AND period_start=$5 AND period_end=$6 AND status='completed'`,
      [organizationId, input.ruleVersion, input.ledgerVersionId, input.receiptsVersionId, input.periodStart, input.periodEnd])).rows[0];
      return { row: existing, reused: true };
    },
    async findCompletedReconciliation(input: { ruleVersion: string; ledgerVersionId: string; receiptsVersionId: string; periodStart: string; periodEnd: string }) {
      return (await client.query<EnterpriseReconciliationRow>(`SELECT ${reconciliationColumns} FROM enterprise.reconciliations
        WHERE organization_id=$1 AND rule_version=$2 AND ledger_version_id=$3 AND receipts_version_id=$4 AND period_start=$5 AND period_end=$6 AND status='completed'`,
      [organizationId, input.ruleVersion, input.ledgerVersionId, input.receiptsVersionId, input.periodStart, input.periodEnd])).rows[0];
    },
    async getReconciliation(id: string) {
      return (await client.query<EnterpriseReconciliationRow>(`SELECT ${reconciliationColumns} FROM enterprise.reconciliations WHERE organization_id=$1 AND id=$2`, [organizationId, id])).rows[0];
    },
    async listReconciliations() {
      return (await client.query<Omit<EnterpriseReconciliationRow, 'result'>>(`SELECT ${reconciliationSummaryColumns} FROM enterprise.reconciliations
        WHERE organization_id=$1 ORDER BY created_at DESC, id LIMIT 100`, [organizationId])).rows;
    },
    async appendAudit(action: string, resourceType: 'task' | 'document' | 'reconciliation', resourceId: string) {
      await client.query('INSERT INTO enterprise.audit_events(organization_id,actor_member_id,action,resource_type,resource_id) VALUES ($1,$2,$3,$4,$5)', [organizationId, memberId, action, resourceType, resourceId]);
    },
    async listAuditEvents() {
      return (await client.query<EnterpriseAuditEventRow>(`SELECT ${auditColumns} FROM enterprise.audit_events WHERE organization_id=$1 ORDER BY occurred_at,id LIMIT 100`, [organizationId])).rows;
    },
  };
}
