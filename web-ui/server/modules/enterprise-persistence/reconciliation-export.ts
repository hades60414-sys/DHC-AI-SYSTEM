import { createHash } from 'node:crypto';

import type { ReconciliationCase, ReconciliationResult } from './reconciliation-acc-match-v1.js';

/**
 * V5 ACC-MATCH-v1 結構化匯出。純函式：內容只由已存的對帳結果與來源 metadata 決定（同輸入同 bytes、同 SHA-256），
 * 不含匯出時間（匯出時間與匯出者記在 reconciliation_exports 與回應標頭）。不重新分類、不新增會計規則：分類、差額與隔離全部取自已存結果。
 */
export const RECONCILIATION_EXPORT_VERSION = 'ACC-MATCH-EXPORT-v1';
export const RECONCILIATION_EXPORT_FORMATS = ['json', 'csv', 'markdown'] as const;
export type ReconciliationExportFormat = (typeof RECONCILIATION_EXPORT_FORMATS)[number];

export type ReconciliationExportSource = {
  side: 'ledger' | 'receipts'; documentId: string; versionNumber: number; versionId: string; filename: string; sha256: string;
  latestVersionNumber: number; superseded: boolean;
};
export type ReconciliationExportInput = {
  reconciliation: { id: string; ruleVersion: string; status: 'completed' | 'rejected'; periodStart: string; periodEnd: string; resultSha256: string;
    createdAt: Date; createdByMemberId: string; result: ReconciliationResult };
  sources: ReconciliationExportSource[];
};

const NOTICE = '確定性規則輸出（ACC-MATCH-v1 一對一比對）：不是會計結論或稽核意見；未支援與例外案件需有權人員人工查核。';

function document(input: ReconciliationExportInput) {
  const { reconciliation, sources } = input;
  const result = reconciliation.result;
  const base = {
    exportVersion: RECONCILIATION_EXPORT_VERSION,
    notice: NOTICE,
    reconciliation: { id: reconciliation.id, ruleVersion: reconciliation.ruleVersion, status: reconciliation.status, periodStart: reconciliation.periodStart,
      periodEnd: reconciliation.periodEnd, timezone: 'Asia/Taipei', resultSha256: reconciliation.resultSha256,
      createdAt: reconciliation.createdAt.toISOString(), createdByMemberId: reconciliation.createdByMemberId },
    sources,
    sourcesSuperseded: sources.some(source => source.superseded),
  };
  if (result.status === 'rejected') return { ...base, errors: result.errors };
  return {
    ...base,
    organizationCode: result.organizationCode,
    counts: result.counts,
    totals: result.totals,
    unsupported: result.cases.filter(item => item.category === 'UNSUPPORTED').map(item => ({ caseId: item.caseId, documentId: item.documentId, reasons: item.reasons })),
    cases: result.cases,
  };
}

/** CSV 公式注入防護：（可含前導空白的）= + @、Tab／CR 開頭，或前導空白後的「-」、「-」後面不是數字，都前置單引號；純數字負差額（-5000）保持原值。所有欄位一律加引號。 */
function cell(value: unknown) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s]*[=+@]/.test(text) || /^[\t\r]/.test(text) || /^\s*-(?!\d)/.test(text) || /^\s+-/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

const sourceText = (item: ReconciliationCase) => item.sources.map(ref => `${ref.side}:L${ref.line}:${ref.rowId}`).join('|');

function csv(input: ReconciliationExportInput) {
  const { reconciliation } = input;
  const result = reconciliation.result;
  const fixed = [RECONCILIATION_EXPORT_VERSION, reconciliation.ruleVersion, reconciliation.id, reconciliation.resultSha256, reconciliation.periodStart, reconciliation.periodEnd];
  const fixedHeader = ['匯出版本', '規則版本', '對帳ID', '結果SHA256', '期間起', '期間迄'];
  if (result.status === 'rejected') {
    const header = [...fixedHeader, '狀態', '來源', '行號', '資料列ID', '錯誤代碼'];
    return [header, ...result.errors.map(error => [...fixed, 'rejected', error.side, error.line, error.rowId, error.code])].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
  }
  const header = [...fixedHeader, '案件ID', '單據ID', '分類代碼', '分類', '原因', '內部帳列ID', '收款列ID', '內部帳幣別', '內部帳合計_最小單位', '收款幣別',
    '收款合計_最小單位', '差額_最小單位', '計入完全匹配合計', '隔離', '來源列'];
  const rows = result.cases.map(item => [...fixed, item.caseId, item.documentId, item.category, item.label, item.reasons.join('|'), item.ledgerRowIds.join('|'),
    item.receiptRowIds.join('|'), item.ledgerCurrency, item.ledgerTotalMinor, item.receiptCurrency, item.receiptTotalMinor, item.differenceMinor,
    item.includedInExactMatchTotal ? 'Y' : 'N', item.isolated ? 'Y' : 'N', sourceText(item)]);
  // UTF-8 BOM 讓試算表正確辨識中文；CRLF 依 RFC 4180。
  return '﻿' + [header, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

function markdown(input: ReconciliationExportInput) {
  const doc = document(input);
  const pipe = (value: unknown) => (value === null || value === undefined || value === '' ? '—' : String(value).replace(/\|/g, '\\|').replace(/\n/g, ' '));
  const table = (header: string[], rows: unknown[][]) => [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(pipe).join(' | ')} |`)].join('\n');
  const r = doc.reconciliation;
  const lines = [
    `# 對帳結果匯出（${r.ruleVersion}）`, '', `> ${NOTICE}`, '',
    table(['項目', '值'], [['匯出版本', doc.exportVersion], ['對帳ID', r.id], ['狀態', r.status], ['期間', `${r.periodStart} 至 ${r.periodEnd}（${r.timezone}）`],
      ['結果 SHA-256', r.resultSha256], ['建立時間', r.createdAt], ['建立者成員ID', r.createdByMemberId]]),
    '', '## 來源版本', '',
    table(['側', '檔名', '文件ID', '版本', '最新版本', '已有新版本', 'SHA-256'],
      doc.sources.map(source => [source.side, source.filename, source.documentId, source.versionNumber, source.latestVersionNumber, source.superseded ? '是' : '否', source.sha256])),
  ];
  if (doc.sourcesSuperseded) lines.push('', '**注意：來源文件已有新版本。本結果只對應上表綁定的版本；新版本需重新對帳。**');
  if ('errors' in doc) {
    lines.push('', '## 拒收原因（整批未產生案件）', '', table(['來源', '行號', '資料列ID', '錯誤代碼'], doc.errors.map(error => [error.side, error.line, error.rowId, error.code])));
  } else {
    const c = doc.counts;
    lines.push('', '## 分類計數', '', table(['案件', '內部帳列', '收款列', '完全匹配', '金額差異', '幣別不一致', '缺收款明細', '缺內部單據', '單據ID重複', '收款ID重複', '未支援待人查核'],
      [[c.cases, c.ledgerRows, c.receiptRows, c.EXACT_MATCH, c.AMOUNT_DIFFERENCE, c.CURRENCY_MISMATCH, c.MISSING_RECEIPT, c.MISSING_INTERNAL, c.DUPLICATE_DOCUMENT_ID, c.DUPLICATE_RECEIPT_ID, c.UNSUPPORTED]]));
    lines.push('', '## 幣別合計（最小單位整數）', '', table(['幣別', '內部帳原始', '收款原始', '隔離內部帳', '隔離收款', '完全匹配'],
      doc.totals.map(total => [total.currency, total.ledgerSourceMinor, total.receiptSourceMinor, total.isolatedLedgerMinor, total.isolatedReceiptMinor, total.exactMatchMinor])));
    lines.push('', '## 案件', '', table(['案件ID', '單據ID', '分類', '內部帳列', '收款列', '內部帳合計', '收款合計', '差額', '隔離', '來源列'],
      doc.cases.map(item => [item.caseId, item.documentId, item.label, item.ledgerRowIds.join(', '), item.receiptRowIds.join(', '),
        item.ledgerTotalMinor === null ? null : `${item.ledgerCurrency} ${item.ledgerTotalMinor}`, item.receiptTotalMinor === null ? null : `${item.receiptCurrency} ${item.receiptTotalMinor}`,
        item.differenceMinor, item.isolated ? '是' : '否', sourceText(item)])));
    lines.push('', '## 未支援待人查核', '', doc.unsupported.length
      ? table(['案件ID', '單據ID', '原因'], doc.unsupported.map(item => [item.caseId, item.documentId, item.reasons.join(', ')]))
      : '本次沒有未支援案件。');
  }
  return lines.join('\n') + '\n';
}

/** 回傳匯出 bytes、SHA-256 與 media type。JSON 為縮排 2 的穩定鍵順序（由 document() 的建構順序固定）。 */
export function buildReconciliationExport(input: ReconciliationExportInput, format: ReconciliationExportFormat) {
  const text = format === 'json' ? `${JSON.stringify(document(input), null, 2)}\n` : format === 'csv' ? csv(input) : markdown(input);
  const content = Buffer.from(text, 'utf8');
  return {
    content, sha256: createHash('sha256').update(content).digest('hex'),
    mediaType: format === 'json' ? 'application/json; charset=utf-8' : format === 'csv' ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8',
    extension: format === 'markdown' ? 'md' : format,
  };
}
