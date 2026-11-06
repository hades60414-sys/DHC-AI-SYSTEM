import { createHash } from 'node:crypto';

/**
 * ACC-MATCH-v1：會計合成對帳的確定性比對規則（docs/enterprise/scenarios/會計對帳/情境與操作規格.md）。
 * 純函式：輸入兩份 CSV 的 bytes 與期間，輸出拒收原因或逐案件結果；不用浮點、不換匯、不呼叫模型、不寫任何系統。
 * 範圍刻意限定為一對一規則（DEC-W6-SCOPE-01）：多對一、跨月、分期、退款、客戶代碼不一致等一律「未支援待人查核」，不猜結果。
 */
export const ACC_MATCH_RULE_VERSION = 'ACC-MATCH-v1';

/** 本規則版本接受的幣別與最小單位小數位數（fixture 單位契約；不是真實會計結論）。 */
const CURRENCY_DECIMALS: Record<string, number> = { TWD: 2, USD: 2 };
const LEDGER_HEADER = ['資料列ID', '組織ID', '單據ID', '單據日期', '客戶代碼', '幣別', '最小單位小數位數', '應收金額_最小單位', '摘要'];
const RECEIPT_HEADER = ['資料列ID', '組織ID', '收款ID', '收款日期', '對應單據ID', '客戶代碼', '幣別', '最小單位小數位數', '收款金額_最小單位', '摘要'];
const MAX_ROWS = 50_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const POSITIVE_INTEGER = /^[1-9]\d{0,17}$/;

export type ReconciliationSide = 'ledger' | 'receipts';
export type ReconciliationInput = {
  ledger: { content: Buffer; versionId: string; sha256: string };
  receipts: { content: Buffer; versionId: string; sha256: string };
  periodStart: string;
  periodEnd: string;
};
export type ReconciliationError = { side: ReconciliationSide | 'request'; line: number | null; rowId: string | null; code: string };
export type ReconciliationSourceRef = { side: ReconciliationSide; versionId: string; sha256: string; line: number; rowId: string };
export type ReconciliationCategory = 'EXACT_MATCH' | 'AMOUNT_DIFFERENCE' | 'CURRENCY_MISMATCH' | 'MISSING_RECEIPT' | 'MISSING_INTERNAL'
  | 'DUPLICATE_DOCUMENT_ID' | 'DUPLICATE_RECEIPT_ID' | 'UNSUPPORTED';
export type ReconciliationCase = {
  caseId: string; documentId: string; category: ReconciliationCategory; label: string; reasons: ReconciliationCategory[];
  ledgerRowIds: string[]; receiptRowIds: string[];
  ledgerCurrency: string | null; ledgerTotalMinor: string | null; receiptCurrency: string | null; receiptTotalMinor: string | null;
  differenceMinor: string | null; includedInExactMatchTotal: boolean; isolated: boolean; sources: ReconciliationSourceRef[];
};
export type ReconciliationResult =
  | { status: 'rejected'; ruleVersion: string; errors: ReconciliationError[] }
  | { status: 'completed'; ruleVersion: string; organizationCode: string; periodStart: string; periodEnd: string; timezone: 'Asia/Taipei';
      counts: Record<ReconciliationCategory, number> & { cases: number; ledgerRows: number; receiptRows: number };
      totals: Array<{ currency: string; ledgerSourceMinor: string; receiptSourceMinor: string; isolatedLedgerMinor: string; isolatedReceiptMinor: string; exactMatchMinor: string }>;
      cases: ReconciliationCase[] };

const LABELS: Record<ReconciliationCategory, string> = {
  EXACT_MATCH: '完全匹配', AMOUNT_DIFFERENCE: '金額差異', CURRENCY_MISMATCH: '幣別不一致', MISSING_RECEIPT: '缺收款明細', MISSING_INTERNAL: '缺內部單據',
  DUPLICATE_DOCUMENT_ID: '單據ID重複', DUPLICATE_RECEIPT_ID: '收款ID重複', UNSUPPORTED: '未支援待人查核',
};

type Row = { line: number; fields: Record<string, string> };

/** 嚴格 CSV：UTF-8（不含 BOM 也接受 BOM）、LF 或 CRLF、逗號分隔、可用雙引號；欄內換行與欄數不符一律拒收。 */
function parseCsv(content: Buffer, header: string[], side: ReconciliationSide, errors: ReconciliationError[]): Row[] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    errors.push({ side, line: null, rowId: null, code: 'ENCODING_NOT_UTF8' });
    return [];
  }
  if (text.startsWith('﻿')) text = text.slice(1);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const split = (line: string, number: number) => {
    const cells: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (quoted) {
        if (char === '"' && line[i + 1] === '"') { cell += '"'; i += 1; } else if (char === '"') quoted = false; else cell += char;
      } else if (char === '"' && cell === '') quoted = true;
      else if (char === ',') { cells.push(cell); cell = ''; } else cell += char;
    }
    if (quoted) { errors.push({ side, line: number, rowId: null, code: 'UNTERMINATED_QUOTE' }); return null; }
    cells.push(cell);
    return cells;
  };
  const head = lines.length ? split(lines[0], 1) : null;
  if (!head || head.join('\u0000') !== header.join('\u0000')) {
    errors.push({ side, line: 1, rowId: null, code: 'HEADER_MISMATCH' });
    return [];
  }
  if (lines.length - 1 > MAX_ROWS) { errors.push({ side, line: null, rowId: null, code: 'TOO_MANY_ROWS' }); return []; }
  if (lines.length < 2) { errors.push({ side, line: null, rowId: null, code: 'NO_DATA_ROWS' }); return []; }
  const rows: Row[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const cells = split(lines[index], index + 1);
    if (!cells) continue;
    if (cells.length !== header.length) { errors.push({ side, line: index + 1, rowId: cells[0] || null, code: 'COLUMN_COUNT' }); continue; }
    rows.push({ line: index + 1, fields: Object.fromEntries(header.map((name, i) => [name, cells[i]])) });
  }
  return rows;
}

function validDate(value: string) {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** 逐列結構檢查；任何一列失敗整批拒收（不產生部分有效批次）。 */
function validateRows(rows: Row[], side: ReconciliationSide, input: ReconciliationInput, errors: ReconciliationError[]) {
  const amountField = side === 'ledger' ? '應收金額_最小單位' : '收款金額_最小單位';
  const dateField = side === 'ledger' ? '單據日期' : '收款日期';
  const idFields = side === 'ledger' ? ['資料列ID', '組織ID', '單據ID', '客戶代碼'] : ['資料列ID', '組織ID', '收款ID', '對應單據ID', '客戶代碼'];
  const seen = new Set<string>();
  for (const { line, fields } of rows) {
    const rowId = fields['資料列ID'] || null;
    const fail = (code: string) => errors.push({ side, line, rowId, code });
    for (const field of idFields) if (!ID.test(fields[field] ?? '')) fail(fields[field] ? `INVALID_${field}` : `MISSING_${field}`);
    if (rowId && seen.has(rowId)) fail('DUPLICATE_ROW_ID');
    if (rowId) seen.add(rowId);
    if (!validDate(fields[dateField])) fail(fields[dateField] ? 'INVALID_DATE' : 'MISSING_DATE');
    else if (fields[dateField] < input.periodStart || fields[dateField] > input.periodEnd) fail('DATE_OUTSIDE_PERIOD');
    const decimals = CURRENCY_DECIMALS[fields['幣別']];
    if (decimals === undefined) fail(fields['幣別'] ? 'UNKNOWN_CURRENCY' : 'MISSING_CURRENCY');
    else if (fields['最小單位小數位數'] !== String(decimals)) fail('CURRENCY_DECIMALS_MISMATCH');
    if (!POSITIVE_INTEGER.test(fields[amountField] ?? '')) fail(fields[amountField] ? 'AMOUNT_NOT_POSITIVE_INTEGER' : 'MISSING_AMOUNT');
  }
}

const sum = (values: bigint[]) => values.reduce((total, value) => total + value, 0n);

/** 執行 ACC-MATCH-v1。輸出完全由輸入 bytes、版本與期間決定（同輸入同輸出、同 hash）。 */
export function runAccMatchV1(input: ReconciliationInput): ReconciliationResult {
  const errors: ReconciliationError[] = [];
  if (!validDate(input.periodStart) || !validDate(input.periodEnd) || input.periodStart > input.periodEnd) {
    return { status: 'rejected', ruleVersion: ACC_MATCH_RULE_VERSION, errors: [{ side: 'request', line: null, rowId: null, code: 'INVALID_PERIOD' }] };
  }
  const ledger = parseCsv(input.ledger.content, LEDGER_HEADER, 'ledger', errors);
  const receipts = parseCsv(input.receipts.content, RECEIPT_HEADER, 'receipts', errors);
  validateRows(ledger, 'ledger', input, errors);
  validateRows(receipts, 'receipts', input, errors);
  const organizations = new Set([...ledger, ...receipts].map(row => row.fields['組織ID']));
  if (organizations.size > 1) errors.push({ side: 'request', line: null, rowId: null, code: 'CROSS_ORGANIZATION' });
  if (errors.length) return { status: 'rejected', ruleVersion: ACC_MATCH_RULE_VERSION, errors };

  const ref = (side: ReconciliationSide, row: Row): ReconciliationSourceRef => ({ side, versionId: input[side].versionId, sha256: input[side].sha256, line: row.line, rowId: row.fields['資料列ID'] });
  const byDocument = new Map<string, { ledger: Row[]; receipts: Row[] }>();
  const group = (key: string) => byDocument.get(key) ?? byDocument.set(key, { ledger: [], receipts: [] }).get(key)!;
  for (const row of ledger) group(row.fields['單據ID']).ledger.push(row);
  for (const row of receipts) group(row.fields['對應單據ID']).receipts.push(row);
  const receiptIdCount = new Map<string, number>();
  for (const row of receipts) receiptIdCount.set(row.fields['收款ID'], (receiptIdCount.get(row.fields['收款ID']) ?? 0) + 1);

  const keys = [...byDocument.keys()].sort();
  const cases = keys.map((documentId, index): ReconciliationCase => {
    const { ledger: l, receipts: r } = byDocument.get(documentId)!;
    const reasons: ReconciliationCategory[] = [];
    if (l.length > 1) reasons.push('DUPLICATE_DOCUMENT_ID');
    if (r.some(row => receiptIdCount.get(row.fields['收款ID'])! > 1)) reasons.push('DUPLICATE_RECEIPT_ID');
    const uniform = (rows: Row[]) => new Set(rows.map(row => `${row.fields['幣別']}/${row.fields['最小單位小數位數']}`)).size <= 1;
    const side = (rows: Row[], field: string) => rows.length && uniform(rows)
      ? { currency: rows[0].fields['幣別'], total: sum(rows.map(row => BigInt(row.fields[field]))) } : { currency: null, total: null };
    const ls = side(l, '應收金額_最小單位');
    const rs = side(r, '收款金額_最小單位');
    let category: ReconciliationCategory;
    let difference: bigint | null = null;
    if (reasons.length) {
      // 重複整組隔離；同側混幣不在組內合計（規格補充），改為未支援待人查核
      category = uniform(l) && uniform(r) ? reasons[0] : 'UNSUPPORTED';
    } else if (r.length > 1) {
      category = 'UNSUPPORTED'; // 多筆不同收款對一單據（多對一）不在 v1 範圍
    } else if (r.length === 0) {
      category = 'MISSING_RECEIPT';
    } else if (l.length === 0) {
      category = 'MISSING_INTERNAL';
    } else if (l[0].fields['客戶代碼'] !== r[0].fields['客戶代碼']) {
      category = 'UNSUPPORTED';
    } else if (ls.currency !== rs.currency || l[0].fields['最小單位小數位數'] !== r[0].fields['最小單位小數位數']) {
      category = 'CURRENCY_MISMATCH';
    } else {
      difference = rs.total! - ls.total!;
      category = difference === 0n ? 'EXACT_MATCH' : 'AMOUNT_DIFFERENCE';
    }
    const isolated = reasons.length > 0;
    return {
      caseId: `ACC-CASE-${String(index + 1).padStart(3, '0')}`, documentId, category, label: LABELS[category], reasons,
      ledgerRowIds: l.map(row => row.fields['資料列ID']), receiptRowIds: r.map(row => row.fields['資料列ID']),
      ledgerCurrency: ls.currency, ledgerTotalMinor: ls.total === null ? null : ls.total.toString(),
      receiptCurrency: rs.currency, receiptTotalMinor: rs.total === null ? null : rs.total.toString(),
      differenceMinor: difference === null ? null : difference.toString(), includedInExactMatchTotal: category === 'EXACT_MATCH', isolated,
      sources: [...l.map(row => ref('ledger', row)), ...r.map(row => ref('receipts', row))],
    };
  });

  const currencies = [...new Set([...ledger, ...receipts].map(row => row.fields['幣別']))].sort();
  const totals = currencies.map(currency => {
    const of = (rows: Row[], field: string, pick: (row: Row) => boolean = () => true) =>
      sum(rows.filter(row => row.fields['幣別'] === currency && pick(row)).map(row => BigInt(row.fields[field]))).toString();
    const isolatedRows = new Set(cases.filter(item => item.isolated).flatMap(item => [...item.ledgerRowIds, ...item.receiptRowIds]));
    const exact = cases.filter(item => item.includedInExactMatchTotal && item.ledgerCurrency === currency);
    return {
      currency,
      ledgerSourceMinor: of(ledger, '應收金額_最小單位'), receiptSourceMinor: of(receipts, '收款金額_最小單位'),
      isolatedLedgerMinor: of(ledger, '應收金額_最小單位', row => isolatedRows.has(row.fields['資料列ID'])),
      isolatedReceiptMinor: of(receipts, '收款金額_最小單位', row => isolatedRows.has(row.fields['資料列ID'])),
      exactMatchMinor: sum(exact.map(item => BigInt(item.ledgerTotalMinor!))).toString(),
    };
  });
  const counts = Object.fromEntries(Object.keys(LABELS).map(key => [key, cases.filter(item => item.category === key).length])) as Record<ReconciliationCategory, number>;
  return {
    status: 'completed', ruleVersion: ACC_MATCH_RULE_VERSION, organizationCode: [...organizations][0], periodStart: input.periodStart, periodEnd: input.periodEnd,
    timezone: 'Asia/Taipei', counts: { ...counts, cases: cases.length, ledgerRows: ledger.length, receiptRows: receipts.length }, totals, cases,
  };
}

/** 正規 JSON：物件鍵依 Unicode 碼位排序、陣列保持順序、無空白。jsonb 會重排鍵，所以 hash 必須與鍵順序無關。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 結果指紋：正規 JSON（見 canonicalJson）的 SHA-256。任何人拿 API 回傳的 result 依同一規則排序鍵即可重算。 */
export function reconciliationResultSha256(result: ReconciliationResult) {
  return createHash('sha256').update(canonicalJson(result)).digest('hex');
}
