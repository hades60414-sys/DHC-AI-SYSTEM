import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { reconciliationResultSha256, runAccMatchV1, type ReconciliationResult } from '../reconciliation-acc-match-v1.js';
import { buildReconciliationExport, type ReconciliationExportInput, type ReconciliationExportSource } from '../reconciliation-export.js';

const FIXTURE = path.resolve('docs/enterprise/scenarios/會計對帳');
const LEDGER = readFileSync(path.join(FIXTURE, '合成內部帳.csv'));
const RECEIPTS = readFileSync(path.join(FIXTURE, '合成收款明細.csv'));
const result = runAccMatchV1({ ledger: { content: LEDGER, versionId: 'v-l', sha256: 'a'.repeat(64) }, receipts: { content: RECEIPTS, versionId: 'v-r', sha256: 'b'.repeat(64) },
  periodStart: '2026-10-01', periodEnd: '2026-10-28' });
const sources = (superseded = false): ReconciliationExportSource[] => [
  { side: 'ledger', documentId: 'd-l', versionNumber: 1, versionId: 'v-l', filename: '合成內部帳.csv', sha256: 'a'.repeat(64), latestVersionNumber: superseded ? 2 : 1, superseded },
  { side: 'receipts', documentId: 'd-r', versionNumber: 1, versionId: 'v-r', filename: '合成收款明細.csv', sha256: 'b'.repeat(64), latestVersionNumber: 1, superseded: false },
];
const input = (value: ReconciliationResult = result, superseded = false): ReconciliationExportInput => ({
  reconciliation: { id: 'r-1', ruleVersion: 'ACC-MATCH-v1', status: value.status, periodStart: '2026-10-01', periodEnd: '2026-10-28', resultSha256: reconciliationResultSha256(value),
    createdAt: new Date('2026-11-06T00:00:00.000Z'), createdByMemberId: 'm-1', result: value },
  sources: sources(superseded),
});
const parseCsv = (text: string) => text.replace(/^﻿/, '').trim().split('\r\n').map(line => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map(match => match[1].replace(/""/g, '"')));

describe('ACC-MATCH-v1 結構化匯出（確定性、可重算 hash、不改寫規則結果）', () => {
  test('JSON：規則／版本、來源版本與 hash、計數、合計、全部案件與已存結果完全一致；同輸入同 bytes', () => {
    assert.equal(result.status, 'completed');
    const exported = buildReconciliationExport(input(), 'json');
    const doc = JSON.parse(exported.content.toString('utf8'));
    assert.equal(exported.sha256, createHash('sha256').update(exported.content).digest('hex'));
    assert.equal(buildReconciliationExport(input(), 'json').sha256, exported.sha256, '決定性');
    assert.deepEqual([doc.exportVersion, doc.reconciliation.ruleVersion, doc.reconciliation.resultSha256, doc.sourcesSuperseded], ['ACC-MATCH-EXPORT-v1', 'ACC-MATCH-v1', reconciliationResultSha256(result), false]);
    assert.deepEqual(doc.sources.map((item: any) => [item.side, item.versionId, item.sha256]), [['ledger', 'v-l', 'a'.repeat(64)], ['receipts', 'v-r', 'b'.repeat(64)]]);
    if (result.status !== 'completed') return;
    assert.deepEqual(doc.cases, JSON.parse(JSON.stringify(result.cases)));
    assert.deepEqual(doc.counts, result.counts);
    assert.deepEqual(doc.totals, result.totals);
    assert.deepEqual(doc.unsupported, []);
    assert.match(doc.notice, /不是會計結論/);
  });

  test('CSV：每案件一列、每列帶規則版本／對帳ID／結果 hash 與來源列；負差額保持數值；BOM＋CRLF', () => {
    const exported = buildReconciliationExport(input(), 'csv');
    const text = exported.content.toString('utf8');
    assert.ok(text.startsWith('﻿') && text.includes('\r\n'));
    const [header, ...rows] = parseCsv(text);
    assert.equal(rows.length, 9);
    const at = (name: string) => header.indexOf(name);
    const case004 = rows.find(row => row[at('案件ID')] === 'ACC-CASE-004')!;
    assert.deepEqual([case004[at('分類代碼')], case004[at('差額_最小單位')], case004[at('規則版本')], case004[at('結果SHA256')]],
      ['AMOUNT_DIFFERENCE', '-5000', 'ACC-MATCH-v1', reconciliationResultSha256(result)]);
    assert.ok(rows.every(row => /^(ledger|receipts):L\d+:/.test(row[at('來源列')])), '每案件都有來源列');
  });

  test('CSV 公式注入防護：= + @ 開頭與「-」接非數字的值前置單引號', () => {
    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') return;
    const hostile = structuredClone(result);
    hostile.cases[0].documentId = '=HYPERLINK("http://x")';
    hostile.cases[1].documentId = '-cmd';
    hostile.cases[2].documentId = '@SUM(A1)';
    const [header, ...rows] = parseCsv(buildReconciliationExport(input(hostile), 'csv').content.toString('utf8'));
    const ids = rows.slice(0, 3).map(row => row[header.indexOf('單據ID')]);
    assert.deepEqual(ids, [`'=HYPERLINK("http://x")`, `'-cmd`, `'@SUM(A1)`]);
  });

  test('未支援清單與來源已改版：UNSUPPORTED 案件逐筆列出；superseded 時 JSON 與 Markdown 都明確標示', () => {
    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') return;
    const withUnsupported = structuredClone(result);
    Object.assign(withUnsupported.cases[8], { category: 'UNSUPPORTED', label: '未支援待人查核', reasons: ['UNSUPPORTED'] });
    const doc = JSON.parse(buildReconciliationExport(input(withUnsupported, true), 'json').content.toString('utf8'));
    assert.deepEqual([doc.unsupported.map((item: any) => item.caseId), doc.sourcesSuperseded, doc.sources[0].latestVersionNumber], [[withUnsupported.cases[8].caseId], true, 2]);
    const md = buildReconciliationExport(input(withUnsupported, true), 'markdown').content.toString('utf8');
    assert.match(md, /來源文件已有新版本/);
    assert.match(md, new RegExp(`\\| ${withUnsupported.cases[8].caseId} \\|`));
    assert.match(buildReconciliationExport(input(), 'markdown').content.toString('utf8'), /本次沒有未支援案件。/);
  });

  test('拒收結果：匯出錯誤清單，不產生案件欄', () => {
    const rejected = runAccMatchV1({ ledger: { content: Buffer.from('x\n'), versionId: 'v-l', sha256: 'a'.repeat(64) }, receipts: { content: RECEIPTS, versionId: 'v-r', sha256: 'b'.repeat(64) },
      periodStart: '2026-10-01', periodEnd: '2026-10-28' });
    assert.equal(rejected.status, 'rejected');
    const doc = JSON.parse(buildReconciliationExport(input(rejected), 'json').content.toString('utf8'));
    assert.deepEqual([doc.cases, doc.errors[0].code], [undefined, 'HEADER_MISMATCH']);
    const [header, first] = parseCsv(buildReconciliationExport(input(rejected), 'csv').content.toString('utf8'));
    assert.equal(first[header.indexOf('錯誤代碼')], 'HEADER_MISMATCH');
    assert.match(buildReconciliationExport(input(rejected), 'markdown').content.toString('utf8'), /拒收原因/);
  });
});
