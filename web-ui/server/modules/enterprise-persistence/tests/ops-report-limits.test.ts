import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import type { EnterpriseDocumentBlobStore } from '@/shared/index.js';

import {
  createOpsReportAccumulator, isoWeekRange, OPS_REPORT_LIST_CAP, OPS_REPORT_MAX_LINE_BYTES, OPS_REPORT_MAX_TOTAL_BYTES, opsReportResultSha256, runOpsReportV1,
  type OpsReportResult, type OpsSource,
} from '../ops-report-v1.js';
import { computeOpsReportFromStore, createComputeGate, type OpsReportPlan } from '../ops-report-runner.js';

const HEADER = '資料標記,案例集,紀錄ID,週別,期間起,期間迄,據點ID,據點名稱,週受理件數,週完成件數,準時完成件數,週末待辦件數,作業分鐘,資料owner,快照ID';
const ORG = '00000000-0000-4000-8000-0000000000aa';
const sha = (content: Buffer) => createHash('sha256').update(content).digest('hex');
/** 合成：count 列，交錯 W42／W43，每兩列一個據點。 */
function rows(count: number, prefix: string) {
  const [a, b] = isoWeekRange('2026-W42')!;
  const [c, d] = isoWeekRange('2026-W43')!;
  const lines = [HEADER];
  for (let i = 0; i < count; i += 1) {
    const current = i % 2 === 1;
    lines.push(`SYNTHETIC,BASE,${prefix}${i},${current ? '2026-W43' : '2026-W42'},${current ? c : a},${current ? d : b},${prefix}S${i >> 1},n,10,9,8,4,60,O,S`);
  }
  return Buffer.from(lines.join('\n') + '\n');
}
const source = (content: Buffer, versionId: string): OpsSource => ({ content, versionId, sha256: sha(content) });
const run = (sources: OpsSource[]) => runOpsReportV1({ sources, week: '2026-W43', datasets: ['BASE'] });
const codes = (result: OpsReportResult) => (result.status === 'rejected' ? [...new Set(result.errors.map(error => error.code))] : []);
const completed = (result: OpsReportResult) => {
  assert.equal(result.status, 'completed', JSON.stringify(codes(result)));
  return result as Extract<OpsReportResult, { status: 'completed' }>;
};

describe('V5.1 RG-V5-01 OPS-REPORT 資源邊界（固定上限、快速拒絕、結果大小有界）', () => {
  test('單一來源 50,000 列合法並完成；結果每主張來源列最多 200 筆、附總數與 truncated，結果 JSON < 2 MB', () => {
    const result = completed(run([source(rows(50_000, 'A'), 'v1')]));
    assert.equal(result.counts.rows, 50_000);
    const first = result.claims[0];
    assert.deepEqual([first.display, first.sourceCount, first.sources.length, first.sourcesTruncated, first.siteCount, first.sites.length, first.sitesTruncated],
      [String(9 * 25_000), 25_000, OPS_REPORT_LIST_CAP, true, 25_000, OPS_REPORT_LIST_CAP, true]);
    assert.deepEqual([result.counts.currentSites, result.sites.length, result.sitesTruncated], [25_000, OPS_REPORT_LIST_CAP, true]);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2 * 1024 * 1024, `result ${Buffer.byteLength(JSON.stringify(result))} bytes`);
  });

  test('五來源合計 50,000 列合法；合計 50,001 列 → TOTAL_ROWS_EXCEEDED（且不再讀後續來源）', () => {
    const legal = completed(run(['A', 'B', 'C', 'D', 'E'].map((p, i) => source(rows(10_000, p), `v${i}`))));
    assert.equal(legal.counts.rows, 50_000);
    const over = run([source(rows(30_000, 'A'), 'v1'), source(rows(20_001, 'B'), 'v2'), source(rows(10, 'C'), 'v3')]);
    assert.deepEqual(codes(over), ['TOTAL_ROWS_EXCEEDED']);
    assert.ok(over.status === 'rejected' && over.errors.every(error => error.source === 1), '在第二個來源即停止');
  });

  test('單一來源 50,001 列 → TOO_MANY_ROWS；單行超過 16 KiB → LINE_TOO_LONG（解碼前）；合計超過 25 MiB → TOTAL_BYTES_EXCEEDED', () => {
    assert.deepEqual(codes(run([source(rows(50_001, 'A'), 'v1')])), ['TOO_MANY_ROWS']);
    const longLine = Buffer.from(`${HEADER}\nSYNTHETIC,BASE,R1,2026-W43,2026-10-19,2026-10-25,S1,${'y'.repeat(OPS_REPORT_MAX_LINE_BYTES)},1,1,1,0,1,O,S\n`);
    const rejected = run([source(longLine, 'v1')]);
    assert.deepEqual([codes(rejected), rejected.status === 'rejected' && rejected.errors[0].line], [['LINE_TOO_LONG'], 2]);
    const big = Buffer.concat([Buffer.from(`${HEADER}\n`), Buffer.alloc(OPS_REPORT_MAX_TOTAL_BYTES, 0x0a)]);
    assert.deepEqual(codes(run([source(big, 'v1')])), ['TOTAL_BYTES_EXCEEDED']);
    // 兩個各約 14 MB 的合法來源（每列 200 個中文字據點名稱）：第一個完成解析，第二個使合計超過 25 MiB
    const wide = (prefix: string) => Buffer.from(rows(20_000, prefix).toString('utf8').replace(/,n,/g, `,${'名'.repeat(200)},`));
    const first = wide('A');
    assert.ok(first.length > OPS_REPORT_MAX_TOTAL_BYTES / 2 && first.length < OPS_REPORT_MAX_TOTAL_BYTES);
    const result = run([source(first, 'v1'), source(wide('B'), 'v2')]);
    assert.deepEqual([codes(result), result.status === 'rejected' && result.errors[0].source], [['TOTAL_BYTES_EXCEEDED'], 1]);
  });

  test('單一超長欄位（≤ 16 KiB 行內）→ TOO_LONG_*；欄位上限仍為 200 字', () => {
    const field = Buffer.from(`${HEADER}\nSYNTHETIC,BASE,R1,2026-W43,2026-10-19,2026-10-25,S1,${'z'.repeat(201)},1,1,1,0,1,O,S\n`);
    assert.deepEqual(codes(run([source(field, 'v1')])), ['TOO_LONG_據點名稱']);
  });

  test('累積器與一次性引擎結果完全相同（同 hash）；拒收後 failed＝true', () => {
    const sources = [source(rows(2_000, 'A'), 'v1'), source(rows(1_000, 'B'), 'v2')];
    const accumulator = createOpsReportAccumulator({ week: '2026-W43', datasets: ['BASE'], sourceCount: 2 });
    for (const item of sources) accumulator.add(item);
    assert.equal(opsReportResultSha256(accumulator.finish()), opsReportResultSha256(run(sources)));
    const failing = createOpsReportAccumulator({ week: '2026-W43', datasets: ['BASE'], sourceCount: 1 });
    failing.add(source(Buffer.from('bad\n'), 'v1'));
    assert.equal(failing.failed, true);
  });

  describe('computeOpsReportFromStore（交易外依序讀 blob）', () => {
    function spyStore(contents: Buffer[]) {
      const blobs = new Map(contents.map(content => [sha(content), content]));
      const calls: string[] = [];
      let inFlight = 0;
      let maxInFlight = 0;
      const store: EnterpriseDocumentBlobStore = {
        async put() { throw new Error('not used'); },
        async get(_org, key) {
          calls.push(key);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise(resolve => setImmediate(resolve));
          inFlight -= 1;
          const content = blobs.get(key);
          if (!content) throw new Error('ENTERPRISE_BLOB_NOT_FOUND');
          return content;
        },
      };
      return { store, calls, get maxInFlight() { return maxInFlight; } };
    }
    const plan = (contents: Buffer[]): OpsReportPlan => ({ organizationId: ORG, week: '2026-W43', periodStart: '2026-10-19', periodEnd: '2026-10-25', datasets: ['BASE'],
      inputKey: 'a'.repeat(64), versions: contents.map((content, i) => ({ id: `00000000-0000-4000-8000-00000000000${i}`, sha256: sha(content), byteSize: content.length })) });

    test('一次只讀一個來源（同時在途 1）；結果與一次性引擎相同', async () => {
      const contents = [rows(400, 'A'), rows(300, 'B'), rows(200, 'C')];
      const spy = spyStore(contents);
      const p = plan(contents);
      const result = await computeOpsReportFromStore(spy.store, p);
      assert.equal(spy.maxInFlight, 1);
      assert.equal(spy.calls.length, 3);
      assert.equal(opsReportResultSha256(result), opsReportResultSha256(runOpsReportV1({ sources: contents.map((content, i) => ({ content, versionId: p.versions[i].id, sha256: sha(content) })), week: '2026-W43', datasets: ['BASE'] })));
    });

    test('第一個來源即拒收 → 不再讀後續來源（快速拒絕）', async () => {
      const contents = [Buffer.from('bad header\n'), rows(10, 'B'), rows(10, 'C')];
      const spy = spyStore(contents);
      const result = await computeOpsReportFromStore(spy.store, plan(contents));
      assert.equal(result.status, 'rejected');
      assert.equal(spy.calls.length, 1);
    });

    test('AbortSignal：中止後不讀下一個來源、丟 ENTERPRISE_REQUEST_ABORTED', async () => {
      const contents = [rows(10, 'A'), rows(10, 'B')];
      const spy = spyStore(contents);
      const controller = new AbortController();
      const store: EnterpriseDocumentBlobStore = { ...spy.store, async get(org, key) { const value = await spy.store.get(org, key); controller.abort(); return value; } };
      await assert.rejects(computeOpsReportFromStore(store, plan(contents), { signal: controller.signal }), /ENTERPRISE_REQUEST_ABORTED/);
      assert.equal(spy.calls.length, 1);
    });

    test('大小或 hash 與版本 metadata 不符 → ENTERPRISE_BLOB_INTEGRITY', async () => {
      const contents = [rows(10, 'A')];
      const p = plan(contents);
      p.versions[0].byteSize += 1;
      await assert.rejects(computeOpsReportFromStore(spyStore(contents).store, p), /ENTERPRISE_BLOB_INTEGRITY/);
    });
  });

  test('計算併發閘門：同時 limit 個、佇列滿立即 429（ENTERPRISE_RATE_LIMITED），釋放後下一個接手', async () => {
    const gate = createComputeGate(1, 1);
    const first = await gate.acquire();
    const second = gate.acquire();
    await assert.rejects(gate.acquire(), /ENTERPRISE_RATE_LIMITED/);
    assert.deepEqual(gate.stats, { active: 1, waiting: 1, limit: 1, queue: 1 });
    first();
    const release = await second;
    assert.deepEqual(gate.stats, { active: 1, waiting: 0, limit: 1, queue: 1 });
    release();
    assert.equal(gate.stats.active, 0);
  });
});
