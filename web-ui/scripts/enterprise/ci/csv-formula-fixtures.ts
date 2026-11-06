/**
 * V5.1 RG-V5-02：產生試算表實測用 CSV。guarded.csv＝真正的 ACC-MATCH 拒收結果經 buildReconciliationExport 匯出（payload 由原始「資料列ID」抵達）；
 * control.csv＝同一批 payload 不加防護（用來證明試算表在該設定下確實會求值）。payloads.json 記錄每個 payload 與其「若被求值」的特徵。
 * 用法：npx tsx --tsconfig server/tsconfig.json scripts/enterprise/ci/csv-formula-fixtures.ts <輸出目錄>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { reconciliationResultSha256, runAccMatchV1 } from '../../../server/modules/enterprise-persistence/reconciliation-acc-match-v1.js';
import { buildReconciliationExport } from '../../../server/modules/enterprise-persistence/reconciliation-export.js';

export const PAYLOADS = ['-1+1', '-2*3', '=1+1', '+1+1', '@SUM(1,2)', '＝1+1', '＋SUM(A1)', '－1+2', '＠SUM(A1)', ' =3+4', '−1+1', '=HYPERLINK("http://example.invalid","x")'];
const out = process.argv[2];
mkdirSync(out, { recursive: true });
const fixture = path.resolve('docs/enterprise/scenarios/會計對帳');
const ledger = readFileSync(path.join(fixture, '合成內部帳.csv'), 'utf8').trim().split('\n');
const receipts = readFileSync(path.join(fixture, '合成收款明細.csv'));
const hostile = Buffer.from([ledger[0], ...PAYLOADS.map((payload, i) => ledger[1].replace(/^[^,]*/, `"${payload.replace(/"/g, '""')}"`).replace(',I001,', `,X${i},`))].join('\n') + '\n');
const result = runAccMatchV1({ ledger: { content: hostile, versionId: 'v-l', sha256: 'a'.repeat(64) }, receipts: { content: receipts, versionId: 'v-r', sha256: 'b'.repeat(64) }, periodStart: '2026-10-01', periodEnd: '2026-10-28' });
if (result.status !== 'rejected') throw new Error('expected rejected');
const exported = buildReconciliationExport({
  reconciliation: { id: 'csv-check', ruleVersion: 'ACC-MATCH-v1', status: 'rejected', periodStart: '2026-10-01', periodEnd: '2026-10-28', resultSha256: reconciliationResultSha256(result), createdAt: new Date(0), createdByMemberId: 'm', result },
  sources: [],
}, 'csv');
writeFileSync(path.join(out, 'guarded.csv'), exported.content);
writeFileSync(path.join(out, 'control.csv'), ['"payload"', ...PAYLOADS.map(payload => `"${payload.replace(/"/g, '""')}"`)].join('\r\n') + '\r\n');
writeFileSync(path.join(out, 'payloads.json'), JSON.stringify(PAYLOADS, null, 1));
console.log(JSON.stringify({ guarded_bytes: exported.content.length, payloads: PAYLOADS.length, reached: PAYLOADS.filter(p => result.errors.some(e => e.rowId === p)).length }));
