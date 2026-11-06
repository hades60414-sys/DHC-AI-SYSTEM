import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';

/**
 * ASTRA-007：草稿引用的結構完整性（不是語義正確性）。
 *
 * 規則：
 * - 內文的每個引用標記（半形 [n] 或全形［n］，n 為 1–4 位數）都必須對應伺服器在產生時寫入的引用 metadata（同 index）。
 * - 被引用的每筆 metadata：chunk 必須在「本組織」存在（RLS 範圍內）、chunk 所屬版本與 metadata 的 documentId／documentVersionId／versionNumber 一致、
 *   chunk 儲存的 hash 等於 metadata 的 excerptSha256，且重算 chunk 原文的 hash 也相同（偵測儲存層漂移）。
 * - 沒有任何引用標記 → UNCITED（來源不足的明確狀態）。
 * 狀態：VALID／INVALID／UNCITED；只有 VALID 能送審、核准、匯出。這個檢查不能證明句子內容被來源支持。
 */
export type CitationStatus = 'VALID' | 'INVALID' | 'UNCITED';
export type CitationReason = 'MISSING_METADATA' | 'SOURCE_NOT_FOUND' | 'VERSION_MISMATCH' | 'HASH_MISMATCH';
export type CitationReport = { cited: number[]; invalid: Array<{ index: number; reason: CitationReason }>; unused: number[] };
type CitationMeta = { index?: unknown; chunkId?: unknown; documentId?: unknown; documentVersionId?: unknown; versionNumber?: unknown; excerptSha256?: unknown };

const MARKER = /[[［]\s*(\d{1,4})\s*[\]］]/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 內文出現的引用編號（去重、遞增）。 */
export function extractCitationIndices(body: string) {
  return [...new Set([...body.matchAll(MARKER)].map(match => Number(match[1])))].sort((a, b) => a - b);
}

export async function validateCitations(client: PoolClient, organizationId: string, body: string, citations: unknown): Promise<{ status: CitationStatus; report: CitationReport }> {
  const metadata = (Array.isArray(citations) ? citations : []) as CitationMeta[];
  const cited = extractCitationIndices(body);
  const byIndex = new Map(metadata.filter(item => Number.isInteger(item?.index)).map(item => [Number(item.index), item]));
  const unused = [...byIndex.keys()].filter(index => !cited.includes(index)).sort((a, b) => a - b);
  if (cited.length === 0) return { status: 'UNCITED', report: { cited, invalid: [], unused } };

  const referenced = cited.map(index => byIndex.get(index)).filter((item): item is CitationMeta => !!item);
  const chunkIds = referenced.map(item => String(item.chunkId ?? '')).filter(id => UUID.test(id));
  const rows = chunkIds.length === 0 ? [] : (await client.query<{ id: string; text: string; textSha256: string; documentVersionId: string; documentId: string; versionNumber: number }>(
    `SELECT c.id, c.text, c.text_sha256 AS "textSha256", c.document_version_id AS "documentVersionId", v.document_id AS "documentId", v.version_number AS "versionNumber"
     FROM enterprise.document_chunks c JOIN enterprise.document_versions v ON (v.organization_id,v.id)=(c.organization_id,c.document_version_id)
     WHERE c.organization_id=$1 AND c.id = ANY($2::uuid[])`, [organizationId, chunkIds])).rows;
  const chunks = new Map(rows.map(row => [row.id, row]));

  const invalid: CitationReport['invalid'] = [];
  for (const index of cited) {
    const meta = byIndex.get(index);
    if (!meta) { invalid.push({ index, reason: 'MISSING_METADATA' }); continue; }
    const chunk = chunks.get(String(meta.chunkId ?? '').toLowerCase());
    if (!chunk) { invalid.push({ index, reason: 'SOURCE_NOT_FOUND' }); continue; }
    if (chunk.documentVersionId !== meta.documentVersionId || chunk.documentId !== meta.documentId || chunk.versionNumber !== Number(meta.versionNumber)) {
      invalid.push({ index, reason: 'VERSION_MISMATCH' }); continue;
    }
    const recomputed = createHash('sha256').update(chunk.text).digest('hex');
    if (chunk.textSha256 !== meta.excerptSha256 || recomputed !== chunk.textSha256) invalid.push({ index, reason: 'HASH_MISMATCH' });
  }
  return { status: invalid.length ? 'INVALID' : 'VALID', report: { cited, invalid, unused } };
}

/** 送審／核准／匯出前呼叫：不是 VALID 就拒絕。 */
export async function requireValidCitations(client: PoolClient, organizationId: string, body: string, citations: unknown) {
  const result = await validateCitations(client, organizationId, body, citations);
  if (result.status !== 'VALID') throw new Error('ENTERPRISE_CITATION_INVALID');
  return result;
}
