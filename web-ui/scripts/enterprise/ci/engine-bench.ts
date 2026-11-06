/**
 * 確定性引擎效能邊界量測（合成資料，純函式，不連 DB）。CI static-and-unit 執行並上傳 JSON。
 * 用法：npx tsx --tsconfig server/tsconfig.json scripts/enterprise/ci/engine-bench.ts <輸出.json>
 * 量測：ACC-MATCH-v1 5 萬列上限（49,999／50,000 成功、50,001 拒收）、OPS-REPORT-v1 5 萬列、匯出 json／csv／markdown；
 * 每項記錄耗時（中位數，3 次）與 heap／RSS 增量。單機單執行緒；不是負載測試。
 */
import { writeFileSync } from 'node:fs';

import { runOpsReportV1, isoWeekRange } from '../../../server/modules/enterprise-persistence/ops-report-v1.js';
import { reconciliationResultSha256, runAccMatchV1 } from '../../../server/modules/enterprise-persistence/reconciliation-acc-match-v1.js';
import { buildReconciliationExport } from '../../../server/modules/enterprise-persistence/reconciliation-export.js';

const LEDGER_HEADER = '資料列ID,組織ID,單據ID,單據日期,客戶代碼,幣別,最小單位小數位數,應收金額_最小單位,摘要';
const RECEIPT_HEADER = '資料列ID,組織ID,收款ID,收款日期,對應單據ID,客戶代碼,幣別,最小單位小數位數,收款金額_最小單位,摘要';
const OPS_HEADER = '資料標記,案例集,紀錄ID,週別,期間起,期間迄,據點ID,據點名稱,週受理件數,週完成件數,準時完成件數,週末待辦件數,作業分鐘,資料owner,快照ID';

function accCsv(rows: number) {
  const ledger = [LEDGER_HEADER];
  const receipts = [RECEIPT_HEADER];
  for (let i = 1; i <= rows; i += 1) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    const amount = 1000 + (i % 997) * 100;
    // 每 50 筆一筆金額差異、每 97 筆一筆缺收款，其餘完全匹配
    ledger.push(`L${i},SYN-ORG,D${i},2026-10-${day},C${i % 300},TWD,2,${amount},合成`);
    if (i % 97 !== 0) receipts.push(`R${i},SYN-ORG,P${i},2026-10-${day},D${i},C${i % 300},TWD,2,${i % 50 === 0 ? amount - 100 : amount},合成`);
  }
  return { ledger: Buffer.from(ledger.join('\n') + '\n'), receipts: Buffer.from(receipts.join('\n') + '\n') };
}

function opsCsv(rows: number) {
  const lines = [OPS_HEADER];
  const [w42s, w42e] = isoWeekRange('2026-W42')!;
  const [w43s, w43e] = isoWeekRange('2026-W43')!;
  for (let i = 0; i < rows; i += 1) {
    const site = `S${Math.floor(i / 2)}`;
    const current = i % 2 === 1;
    lines.push(`SYNTHETIC,BASE,R${i},${current ? '2026-W43' : '2026-W42'},${current ? w43s : w42s},${current ? w43e : w42e},${site},站${site},10,9,8,${current ? 5 : 4},60,OWNER,SNAP`);
  }
  return Buffer.from(lines.join('\n') + '\n');
}

function measure<T>(run: () => T, repeat = 3) {
  const times: number[] = [];
  let result!: T;
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const rssBefore = process.memoryUsage().rss;
  let heapPeak = heapBefore;
  for (let i = 0; i < repeat; i += 1) {
    const started = process.hrtime.bigint();
    result = run();
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
    heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
  }
  times.sort((a, b) => a - b);
  return { result, median_ms: Math.round(times[Math.floor(times.length / 2)]), max_ms: Math.round(times.at(-1)!),
    heap_delta_mb: Math.round((heapPeak - heapBefore) / 1048576), rss_delta_mb: Math.round((process.memoryUsage().rss - rssBefore) / 1048576) };
}

const out: Record<string, unknown> = { node: process.version, arch: process.arch, platform: process.platform, measured_at: new Date().toISOString(), note: '單執行緒純函式；不含 DB、storage 與 HTTP' };
const period = { periodStart: '2026-10-01', periodEnd: '2026-10-28' };
const acc = (rows: number) => {
  const { ledger, receipts } = accCsv(rows);
  return () => runAccMatchV1({ ledger: { content: ledger, versionId: 'l', sha256: 'a'.repeat(64) }, receipts: { content: receipts, versionId: 'r', sha256: 'b'.repeat(64) }, ...period });
};
for (const rows of [10_000, 49_999, 50_000]) {
  const m = measure(acc(rows));
  out[`acc_match_${rows}`] = { ...m, result: undefined, status: m.result.status, cases: m.result.status === 'completed' ? m.result.cases.length : null };
}
const over = measure(acc(50_001), 1);
out.acc_match_50001 = { ...over, result: undefined, status: over.result.status, errors: over.result.status === 'rejected' ? over.result.errors.map(error => error.code) : null };

const big = acc(50_000)();
if (big.status !== 'completed') throw new Error('50k 對帳應成功');
const input = { reconciliation: { id: 'bench', ruleVersion: 'ACC-MATCH-v1', status: big.status, ...period, resultSha256: reconciliationResultSha256(big), createdAt: new Date(0), createdByMemberId: 'm', result: big },
  sources: [{ side: 'ledger' as const, documentId: 'd1', versionNumber: 1, versionId: 'l', filename: 'l.csv', sha256: 'a'.repeat(64), latestVersionNumber: 1, superseded: false },
    { side: 'receipts' as const, documentId: 'd2', versionNumber: 1, versionId: 'r', filename: 'r.csv', sha256: 'b'.repeat(64), latestVersionNumber: 1, superseded: false }] };
for (const format of ['json', 'csv', 'markdown'] as const) {
  const m = measure(() => buildReconciliationExport(input, format));
  out[`export_${format}_50000_cases`] = { ...m, result: undefined, bytes: m.result.content.length };
}
const ops = opsCsv(50_000);
const m = measure(() => runOpsReportV1({ sources: [{ content: ops, versionId: 'o', sha256: 'c'.repeat(64) }], week: '2026-W43', datasets: ['BASE'] }));
out.ops_report_50000_rows = { ...m, result: undefined, status: m.result.status, sites: m.result.status === 'completed' ? m.result.sites.length : null };
out.peak_rss_mb = Math.round(process.memoryUsage().rss / 1048576);
// 契約邊界：5 萬列成功、50,001 列拒收（TOO_MANY_ROWS）；不符即 exit 1。耗時只記錄，不設門檻（尚無核准的 SLO）。
const boundaryOk = (out.acc_match_50000 as { status: string }).status === 'completed'
  && (out.acc_match_50001 as { status: string; errors: string[] }).status === 'rejected'
  && (out.acc_match_50001 as { errors: string[] }).errors.includes('TOO_MANY_ROWS');
out.boundary = boundaryOk ? 'PASS' : 'FAIL';
writeFileSync(process.argv[2], JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify(out));
if (!boundaryOk) process.exitCode = 1;
