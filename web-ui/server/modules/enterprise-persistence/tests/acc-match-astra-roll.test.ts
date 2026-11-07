import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { isoWeekRange, runOpsReportV1 } from '../ops-report-v1.js';
import { runAccMatchV1, type ReconciliationResult } from '../reconciliation-acc-match-v1.js';

/**
 * V5.2 ASTRA-ROLL-003／004／005／011：以獨立手算的 golden 驗證（不由引擎輸出回填）。
 */
const LEDGER_HEADER = '資料列ID,組織ID,單據ID,單據日期,客戶代碼,幣別,最小單位小數位數,應收金額_最小單位,摘要';
const RECEIPT_HEADER = '資料列ID,組織ID,收款ID,收款日期,對應單據ID,客戶代碼,幣別,最小單位小數位數,收款金額_最小單位,摘要';
const csv = (header: string, rows: string[]) => Buffer.from(`${header}\n${rows.join('\n')}\n`, 'utf8');
const run = (ledger: string[], receipts: string[]) => runAccMatchV1({
  ledger: { content: csv(LEDGER_HEADER, ledger), versionId: 'v-l', sha256: 'a'.repeat(64) },
  receipts: { content: csv(RECEIPT_HEADER, receipts), versionId: 'v-r', sha256: 'b'.repeat(64) },
  periodStart: '2026-10-01', periodEnd: '2026-10-31',
});
const codes = (result: ReconciliationResult) => (result.status === 'rejected' ? result.errors.map(error => error.code) : []);
const completed = (result: ReconciliationResult) => {
  assert.equal(result.status, 'completed', JSON.stringify(codes(result)));
  return result as Extract<ReconciliationResult, { status: 'completed' }>;
};

describe('V5.2 ASTRA-ROLL ACC-MATCH-v1 資料正確性', () => {
  test('ROLL-003：兩側資料列ID 同名時，隔離合計只計同側且屬隔離案件的列（手算 golden）', () => {
    // 內部帳：L1/D1=100（完全匹配）、L2/D2=10、L3/D2=20（D2 單據ID重複→隔離）；收款：R1/D1=100、「L1」/D2=30（與內部帳 L1 同名）
    const result = completed(run(
      ['L1,ORG,D1,2026-10-05,C1,TWD,2,100,x', 'L2,ORG,D2,2026-10-06,C1,TWD,2,10,x', 'L3,ORG,D2,2026-10-07,C1,TWD,2,20,x'],
      ['R1,ORG,P1,2026-10-08,D1,C1,TWD,2,100,x', 'L1,ORG,P2,2026-10-09,D2,C1,TWD,2,30,x'],
    ));
    const twd = result.totals.find(total => total.currency === 'TWD')!;
    assert.deepEqual([twd.ledgerSourceMinor, twd.receiptSourceMinor, twd.isolatedLedgerMinor, twd.isolatedReceiptMinor, twd.exactMatchMinor], ['130', '130', '30', '30', '100']);
    // rename-only：把收款「L1」改名為「R2」，所有合計不變
    const renamed = completed(run(
      ['L1,ORG,D1,2026-10-05,C1,TWD,2,100,x', 'L2,ORG,D2,2026-10-06,C1,TWD,2,10,x', 'L3,ORG,D2,2026-10-07,C1,TWD,2,20,x'],
      ['R1,ORG,P1,2026-10-08,D1,C1,TWD,2,100,x', 'R2,ORG,P2,2026-10-09,D2,C1,TWD,2,30,x'],
    ));
    assert.deepEqual(renamed.totals, result.totals);
  });

  test('V5.3 golden（人工手算 JSON）：跨側同列ID 的案件、計數與兩幣別合計', () => {
    const golden = path.resolve('docs/enterprise/scenarios/會計對帳/golden');
    const expected = JSON.parse(readFileSync(path.join(golden, '跨側同列ID_預期.json'), 'utf8'));
    const result = completed(runAccMatchV1({ ledger: { content: readFileSync(path.join(golden, '跨側同列ID_內部帳.csv')), versionId: 'v-l', sha256: 'a'.repeat(64) },
      receipts: { content: readFileSync(path.join(golden, '跨側同列ID_收款明細.csv')), versionId: 'v-r', sha256: 'b'.repeat(64) }, ...expected.period }));
    assert.deepEqual(result.cases.map(item => ({ documentId: item.documentId, category: item.category, ledgerRowIds: item.ledgerRowIds, receiptRowIds: item.receiptRowIds, differenceMinor: item.differenceMinor, isolated: item.isolated })), expected.cases);
    assert.deepEqual(result.totals, expected.totals.map(({ derivation: _d, ...rest }: Record<string, string>) => rest));
    for (const [key, value] of Object.entries(expected.counts)) assert.equal((result.counts as Record<string, number>)[key], value, key);
  });

  test('ROLL-004：閉引號後還有字元（"100"000）→ 拒收；合法引號欄（含逗號、跳脫雙引號）仍可', () => {
    const bad = run(['L1,ORG,D1,2026-10-05,C1,TWD,2,"100"000,x'], ['R1,ORG,P1,2026-10-08,D1,C1,TWD,2,100000,x']);
    assert.deepEqual(codes(bad), ['TEXT_AFTER_CLOSING_QUOTE']);
    const good = completed(run(['L1,ORG,D1,2026-10-05,C1,TWD,2,"100000","摘要, 含逗號 ""引號"""'], ['R1,ORG,P1,2026-10-08,D1,C1,TWD,2,100000,x']));
    assert.equal(good.cases[0].category, 'EXACT_MATCH');
    assert.ok(codes(run(['L1,ORG,D1,2026-10-05,C1,TWD,2,1"00,x'], ['R1,ORG,P1,2026-10-08,D1,C1,TWD,2,100,x'])).length > 0, '未加引號欄內出現雙引號');
  });

  test('ROLL-005：幣別只接受白名單自有鍵（__proto__／constructor／toString → UNKNOWN_CURRENCY）', () => {
    for (const [currency, decimals] of [['__proto__', '[object Object]'], ['constructor', '2'], ['toString', '2'], ['hasOwnProperty', '2'], ['JPY', '0']]) {
      const result = run([`L1,ORG,D1,2026-10-05,C1,${currency},${decimals},100,x`], [`R1,ORG,P1,2026-10-08,D1,C1,${currency},${decimals},100,x`]);
      assert.ok(codes(result).includes('UNKNOWN_CURRENCY'), `${currency} → ${JSON.stringify(codes(result))}`);
    }
    assert.equal(completed(run(['L1,ORG,D1,2026-10-05,C1,USD,2,100,x'], ['R1,ORG,P1,2026-10-08,D1,C1,USD,2,100,x'])).cases[0].category, 'EXACT_MATCH');
  });
});

describe('V5.2 ASTRA-ROLL OPS-REPORT-v1 邊界', () => {
  const OPS_HEADER = '資料標記,案例集,紀錄ID,週別,期間起,期間迄,據點ID,據點名稱,週受理件數,週完成件數,準時完成件數,週末待辦件數,作業分鐘,資料owner,快照ID';
  const ops = (rows: string[], week: string) => runOpsReportV1({ sources: [{ content: Buffer.from(`${OPS_HEADER}\n${rows.join('\n')}\n`), versionId: 'v', sha256: 'a'.repeat(64) }], week, datasets: ['BASE'] });

  test('ROLL-011：前週超出可表示範圍的最小週別（1970-W01）→ 明確拒收 INVALID_WEEK，不丟 TypeError；1970-W02 可用', () => {
    assert.deepEqual(isoWeekRange('1970-W01'), ['1969-12-29', '1970-01-04']);
    const minimum = ops([], '1970-W01');
    assert.deepEqual(minimum.status === 'rejected' ? minimum.errors.map(error => error.code) : minimum.status, ['INVALID_WEEK']);
    assert.equal(ops([], '1970-W02').status, 'completed');
  });

  test('ROLL-004（OPS）：閉引號後還有字元 → 拒收', () => {
    const result = ops(['SYNTHETIC,BASE,R1,2026-W43,2026-10-19,2026-10-25,S1,n,"10"5,9,8,4,60,O,S'], '2026-W43');
    assert.deepEqual(result.status === 'rejected' ? result.errors.map(error => error.code) : result.status, ['TEXT_AFTER_CLOSING_QUOTE']);
  });

  test('ROLL-010：同週同站 5 萬列合法衝突輸入在有界時間內完成（V5.1 已改 Map 就地 append／Set）', () => {
    const [start, end] = isoWeekRange('2026-W43')!;
    const rows = Array.from({ length: 50_000 }, (_, i) => `SYNTHETIC,BASE,R${i},2026-W43,${start},${end},SAME,n,1,1,1,0,1,O,S`);
    const started = Date.now();
    const result = ops(rows, '2026-W43');
    const elapsed = Date.now() - started;
    assert.equal(result.status, 'completed');
    if (result.status === 'completed') {
      assert.deepEqual([result.counts.conflicts, result.claims[0].status, result.claims[0].sourceCount], [1, 'CONFLICT', 50_000]);
      assert.equal(result.conflicts[0].sources.length, 50_000, '衝突來源完整列出（每衝突一筆，非截斷對象）');
    }
    assert.ok(elapsed < 10_000, `${elapsed} ms`);
  });
});
