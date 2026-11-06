import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { isoWeekRange, opsReportResultSha256, runOpsReportV1, validateOpsNarrative, type OpsReportResult, type OpsSource } from '../ops-report-v1.js';

const FIXTURE = path.resolve('docs/enterprise/scenarios/營運週報');
const CSV = readFileSync(path.join(FIXTURE, '合成營運明細.csv'));
const HEADER = CSV.toString('utf8').split('\n')[0];
const source = (content: Buffer = CSV, versionId = 'v-ops-1', sha256 = 'a'.repeat(64)): OpsSource => ({ content, versionId, sha256 });
const run = (sources: OpsSource[] = [source()], week = '2026-W43', datasets = ['BASE']) => runOpsReportV1({ sources, week, datasets });
const completed = (result: OpsReportResult) => {
  assert.equal(result.status, 'completed', JSON.stringify(result));
  return result as Extract<OpsReportResult, { status: 'completed' }>;
};
const codes = (result: OpsReportResult) => (result.status === 'rejected' ? result.errors.map(error => error.code) : []);
const claimOf = (result: OpsReportResult, id: string) => completed(result).claims.find(item => item.claimId === id)!;
const variant = (from: string, to: string) => {
  const text = CSV.toString('utf8');
  assert.ok(text.includes(from), `fixture 不含 ${from}`);
  return Buffer.from(text.replace(from, to), 'utf8');
};
/** 自訂列（欄序與 fixture 標頭相同）。 */
const csvOf = (rows: string[][]) => Buffer.from(`${HEADER}\n${rows.map(row => row.join(',')).join('\n')}\n`, 'utf8');
const row = (id: string, week: string, site: string, [intake, done, onTime, backlog, minutes]: string[], dataset = 'BASE') => {
  const [start, end] = isoWeekRange(week)!;
  return ['SYNTHETIC', dataset, id, week, start, end, site, `虛構${site}`, intake, done, onTime, backlog, minutes, `OWNER-${site}`, 'SNAP-01'];
};

describe('OPS-REPORT-v1（確定性營運週報；以情境規格的人工核算 oracle 比對）', () => {
  test('正常週：14 項主張的值、狀態與來源紀錄 ID 與 預期主張.csv 逐項一致', () => {
    const result = completed(run());
    const oracle = readFileSync(path.join(FIXTURE, '預期主張.csv'), 'utf8').trim().split('\n').slice(1).map(line => line.split(','));
    assert.equal(result.claims.length, oracle.length);
    for (const [claimId, , expected, , , recordIds] of oracle) {
      const actual = claimOf(result, claimId);
      if (expected === 'UNKNOWN') assert.deepEqual([actual.status, actual.value, actual.display], ['UNKNOWN', null, null], claimId);
      else assert.deepEqual([actual.status, actual.display], ['OK', expected], claimId);
      assert.deepEqual(actual.sources.map(ref => ref.recordId).sort(), recordIds.split(';').sort(), `${claimId} 來源`);
    }
    // 分子分母保留未四捨五入值，可獨立重算
    assert.deepEqual([claimOf(result, 'OP-CLM-09').numerator, claimOf(result, 'OP-CLM-09').denominator, claimOf(result, 'OP-CLM-09').sites], ['150', '160', ['SYN-A', 'SYN-B']]);
    assert.deepEqual([claimOf(result, 'OP-CLM-11').value, claimOf(result, 'OP-CLM-11').scale, claimOf(result, 'OP-CLM-11').unit], ['89', 2, 'percentage_point']);
    assert.ok(claimOf(result, 'OP-CLM-12').reasons.includes('FIELD_UNKNOWN:2026-W43:SYN-C:準時完成件數'));
    assert.ok(claimOf(result, 'OP-CLM-09').reasons.includes('EXCLUDED_ONTIME_UNKNOWN:SYN-C'));
    assert.deepEqual([result.periodStart, result.periodEnd, result.previousWeek, result.counts.selectedRows, result.counts.excludedRows], ['2026-10-19', '2026-10-25', '2026-W42', 6, 1]);
    assert.deepEqual(result.anomalies, [], '固定 fixture 守恆成立');
    const ref = claimOf(result, 'OP-CLM-01').sources.find(item => item.recordId === 'OPS-BASE-W43-C')!;
    assert.deepEqual(ref, { versionId: 'v-ops-1', sha256: 'a'.repeat(64), line: 7, recordId: 'OPS-BASE-W43-C' }, '行號與規格 #L7 一致');
  });

  test('重複來源（OP-NEG-02）：同時選 BASE＋NEG-CONFLICT → 乙站本週 CONFLICT，列出雙方，不挑版本；前週主張不受影響', () => {
    const result = completed(run([source()], '2026-W43', ['BASE', 'NEG-CONFLICT']));
    assert.deepEqual(result.conflicts.map(item => [item.week, item.siteId, item.sources.map(ref => ref.recordId)]), [['2026-W43', 'SYN-B', ['OPS-BASE-W43-B', 'OPS-ALT-W43-B']]]);
    for (const id of ['OP-CLM-01', 'OP-CLM-03', 'OP-CLM-04', 'OP-CLM-09', 'OP-CLM-11', 'OP-CLM-12', 'OP-CLM-14']) {
      assert.deepEqual([claimOf(result, id).status, claimOf(result, id).value], ['CONFLICT', null], id);
    }
    assert.ok(claimOf(result, 'OP-CLM-01').sources.some(ref => ref.recordId === 'OPS-ALT-W43-B'));
    assert.deepEqual([claimOf(result, 'OP-CLM-02').status, claimOf(result, 'OP-CLM-02').display], ['OK', '180']);
    assert.deepEqual([claimOf(result, 'OP-CLM-07').status, claimOf(result, 'OP-CLM-07').display], ['OK', '46']);
  });

  test('空週：沒有任何本週列 → 全部主張 UNKNOWN（不寫 0 件）', () => {
    const result = completed(run([source()], '2026-W45'));
    assert.deepEqual(result.sites, []);
    assert.ok(result.claims.every(item => item.status === 'UNKNOWN' && item.value === null), JSON.stringify(result.claims.map(item => [item.claimId, item.status])));
  });

  test('跨月週與 ISO 週邊界：W44 跨 10/11 月、2026-W53 跨年、2027 沒有 W53', () => {
    assert.deepEqual(isoWeekRange('2026-W44'), ['2026-10-26', '2026-11-01']);
    assert.deepEqual(isoWeekRange('2026-W01'), ['2025-12-29', '2026-01-04']);
    assert.deepEqual(isoWeekRange('2026-W53'), ['2026-12-28', '2027-01-03']);
    assert.equal(isoWeekRange('2027-W53'), null);
    assert.equal(isoWeekRange('2026-W00'), null);
    const content = csvOf([row('X-43-A', '2026-W43', 'SYN-A', ['10', '8', '8', '4', '60']), row('X-44-A', '2026-W44', 'SYN-A', ['12', '10', '9', '6', '70'])]);
    const result = completed(run([source(content)], '2026-W44'));
    assert.deepEqual([result.periodStart, result.periodEnd, result.previousWeek], ['2026-10-26', '2026-11-01', '2026-W43']);
    assert.deepEqual(['OP-CLM-01', 'OP-CLM-02', 'OP-CLM-04', 'OP-CLM-12'].map(id => claimOf(result, id).display), ['10', '8', '25.00', '90.00']);
    const yearEnd = csvOf([row('Y-53', '2026-W53', 'SYN-A', ['1', '1', '1', '0', '1']), row('Y-01', '2027-W01', 'SYN-A', ['2', '2', '1', '0', '1'])]);
    assert.equal(completed(run([source(yearEnd)], '2027-W01')).previousWeek, '2026-W53');
    assert.equal(claimOf(run([source(yearEnd)], '2027-W01'), 'OP-CLM-03').display, '1');
  });

  test('重複來源檔：同一內容當兩個來源 → 紀錄 ID 重複整批拒收（不加倍計數）', () => {
    const result = run([source(), source(CSV, 'v-ops-2', 'b'.repeat(64))]);
    assert.equal(result.status, 'rejected');
    assert.equal(codes(result).filter(code => code === 'DUPLICATE_RECORD_ID').length, 7);
  });

  test('缺欄位：識別／owner 欄空白拒收；件數空白是 UNKNOWN 不是 0（OP-NEG-01）', () => {
    assert.deepEqual(codes(run([source(variant('SYNTHETIC,BASE,OPS-BASE-W42-A', 'SYNTHETIC,BASE,'))])), ['MISSING_紀錄ID']);
    assert.deepEqual(codes(run([source(variant(',SYN-OWNER-B,SYN-SNAPSHOT-01\nSYNTHETIC,BASE,OPS-BASE-W42-C', ',,SYN-SNAPSHOT-01\nSYNTHETIC,BASE,OPS-BASE-W42-C'))])), ['MISSING_資料owner']);
    assert.ok(codes(run([source(variant(',84,80,76,20,960,', ',84,8.5,76,20,960,'))])).includes('INVALID_週完成件數'));
    assert.ok(codes(run([source(variant(',84,80,76,20,960,', ',84,-80,76,20,960,'))])).includes('INVALID_週完成件數'));
    const blank = completed(run([source(variant(',95,90,87,25,1020,', ',95,,87,25,1020,'))]));
    assert.deepEqual([claimOf(blank, 'OP-CLM-01').status, claimOf(blank, 'OP-CLM-05').display], ['UNKNOWN', '225']);
  });

  test('錯誤期間：週別不存在 → INVALID_WEEK；列的起訖不符週別 → PERIOD_MISMATCH；案例集參數不合法 → 拒收', () => {
    assert.deepEqual(codes(run([source()], '2026-W60')), ['INVALID_WEEK']);
    assert.deepEqual(codes(run([source()], '2026-43')), ['INVALID_WEEK']);
    assert.deepEqual(codes(run([source(variant('2026-W43,2026-10-19,2026-10-25,SYN-A', '2026-W43,2026-10-20,2026-10-25,SYN-A'))])), ['PERIOD_MISMATCH']);
    assert.deepEqual(codes(run([source()], '2026-W43', [])), ['INVALID_DATASETS']);
    assert.deepEqual(codes(run([source()], '2026-W43', ['BASE', 'BASE'])), ['INVALID_DATASETS']);
    assert.deepEqual(codes(run([source(Buffer.from('a,b\n1,2\n'))])), ['HEADER_MISMATCH']);
    assert.deepEqual(codes(run([source(Buffer.from([0xff, 0xfe, 0x00]))])), ['ENCODING_NOT_UTF8']);
  });

  test('異常：守恆不成立只列異常不改值；準時數大於完成數 → 異常且該站排除於準時率', () => {
    const conservation = completed(run([source(variant(',55,50,,15,660,', ',55,50,,16,660,'))]));
    assert.deepEqual(conservation.anomalies, [{ code: 'BACKLOG_CONSERVATION', week: '2026-W43', siteId: 'SYN-C', recordIds: ['OPS-BASE-W42-C', 'OPS-BASE-W43-C'] }]);
    assert.equal(claimOf(conservation, 'OP-CLM-06').display, '62');
    const excess = completed(run([source(variant(',95,90,87,25,1020,', ',95,90,91,25,1020,'))]));
    assert.deepEqual(excess.anomalies.map(item => [item.code, item.siteId]), [['ONTIME_EXCEEDS_COMPLETED', 'SYN-A']]);
    assert.deepEqual([claimOf(excess, 'OP-CLM-09').sites, claimOf(excess, 'OP-CLM-09').display], [['SYN-B'], '90.00']);
    assert.equal(claimOf(excess, 'OP-CLM-14').display, '33.33');
    const siteChange = completed(run([source(csvOf([row('S-42-A', '2026-W42', 'SYN-A', ['1', '1', '1', '0', '1']), row('S-43-B', '2026-W43', 'SYN-B', ['1', '1', '1', '0', '1'])]))]));
    assert.deepEqual(siteChange.anomalies.map(item => [item.code, item.siteId]), [['SITE_SET_CHANGED', 'SYN-A'], ['SITE_SET_CHANGED', 'SYN-B']]);
    assert.ok(claimOf(siteChange, 'OP-CLM-02').reasons.includes('SITE_MISSING:2026-W42:SYN-B'));
  });

  test('ROUND_HALF_UP 與符號：0.00625% → 0.01、−0.00625% → −0.01；前週 0 → UNKNOWN（分母為 0）', () => {
    const growth = (before: string, after: string) => claimOf(run([source(csvOf([row('R-42', '2026-W42', 'SYN-A', ['1', before, '0', '0', '1']), row('R-43', '2026-W43', 'SYN-A', ['1', after, '0', '0', '1'])]))]), 'OP-CLM-04');
    assert.deepEqual([growth('16000', '16001').display, growth('16000', '16001').numerator, growth('16000', '16001').denominator], ['0.01', '1', '16000']);
    assert.equal(growth('16000', '15999').display, '-0.01');
    assert.equal(growth('90', '80').display, '-11.11');
    assert.deepEqual([growth('0', '5').status, growth('0', '5').reasons.includes('DENOMINATOR_ZERO')], ['UNKNOWN', true]);
  });

  test('版本變更與決定性：同輸入同 hash；來源改版（不同版本／hash）→ 結果與來源指向新版本', () => {
    const first = run();
    assert.equal(opsReportResultSha256(first), opsReportResultSha256(run()));
    const revised = run([source(variant(',55,50,,15,660,', ',55,50,48,15,660,'), 'v-ops-2', 'c'.repeat(64))]);
    assert.notEqual(opsReportResultSha256(revised), opsReportResultSha256(first));
    assert.deepEqual([claimOf(revised, 'OP-CLM-12').status, claimOf(revised, 'OP-CLM-12').display], ['OK', '94.29']);
    assert.ok(claimOf(revised, 'OP-CLM-12').sources.every(ref => ref.versionId === 'v-ops-2' && ref.sha256 === 'c'.repeat(64)));
  });

  test('敘述驗證（模型只寫文字）：數字必須出自引擎；百分點不得寫成 %；不得引用 UNKNOWN 主張；無來源的節省宣稱被擋（OP-NEG-03／06）', () => {
    const result = completed(run());
    assert.deepEqual(validateOpsNarrative('2026-W43 三據點完成 210 件 [OP-CLM-01]，較前週增加 30 件、16.67%；甲乙準時率 93.75%（150/160），提高 0.89 百分點 [OP-CLM-11]。', result),
      { ok: true, violations: [] });
    assert.deepEqual(validateOpsNarrative('準時率提高 0.89%。', result).violations, [{ token: '0.89%', code: 'PERCENTAGE_POINT_AS_PERCENT' }]);
    assert.deepEqual(validateOpsNarrative('本週節省 35% 成本。', result).violations, [{ token: '35%', code: 'NUMBER_NOT_FROM_ENGINE' }]);
    assert.deepEqual(validateOpsNarrative('全據點準時率見 [OP-CLM-12]。', result).violations, [{ token: 'OP-CLM-12', code: 'CLAIM_NOT_OK' }]);
    assert.deepEqual(validateOpsNarrative('完成 999 件 [OP-CLM-99]。', result).violations.map(item => item.code), ['UNKNOWN_CLAIM_REFERENCE', 'NUMBER_NOT_FROM_ENGINE']);
  });

  test('上限：超過 50,000 列拒收；5 個以上來源拒收', () => {
    const many = Buffer.from(`${HEADER}\n${'x\n'.repeat(50_001)}`, 'utf8');
    assert.deepEqual(codes(run([source(many)])), ['TOO_MANY_ROWS']);
    assert.deepEqual(codes(run(Array.from({ length: 6 }, (_, i) => source(CSV, `v${i}`)))), ['INVALID_SOURCES']);
  });
});
