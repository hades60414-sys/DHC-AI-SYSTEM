/**
 * OPS-REPORT 資源邊界探針（合成資料，純函式）。每個情境在獨立子行程執行，量 wall time 與子行程峰值 RSS（/usr/bin/time 不可攜，改用 process.resourceUsage().maxRSS）。
 * 用法：npx tsx --tsconfig server/tsconfig.json scripts/enterprise/ci/ops-resource-probe.ts <輸出.json> [情境…]
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { isoWeekRange, runOpsReportV1 } from '../../../server/modules/enterprise-persistence/ops-report-v1.js';

const HEADER = '資料標記,案例集,紀錄ID,週別,期間起,期間迄,據點ID,據點名稱,週受理件數,週完成件數,準時完成件數,週末待辦件數,作業分鐘,資料owner,快照ID';
const MiB = 1024 * 1024;

function rows(count: number, prefix: string, pad = 0) {
  const [s42, e42] = isoWeekRange('2026-W42')!;
  const [s43, e43] = isoWeekRange('2026-W43')!;
  const name = 'x'.repeat(Math.min(pad, 200));
  const lines = [HEADER];
  for (let i = 0; i < count; i += 1) {
    const current = i % 2 === 1;
    lines.push(`SYNTHETIC,BASE,${prefix}${i},${current ? '2026-W43' : '2026-W42'},${current ? s43 : s42},${current ? e43 : e42},${prefix}S${i >> 1},${name},10,9,8,4,60,OWNER,SNAP`);
  }
  return Buffer.from(lines.join('\n') + '\n');
}

const SCENARIOS: Record<string, () => Buffer[]> = {
  single_50k: () => [rows(50_000, 'A')],
  five_x_10k_legal_aggregate: () => ['A', 'B', 'C', 'D', 'E'].map(p => rows(10_000, p)),
  one_huge_line_20MiB: () => [Buffer.concat([Buffer.from(HEADER + '\n'), Buffer.alloc(20 * MiB, 0x61), Buffer.from('\n')])],
  same_site_conflict_50k: () => {
    const [s43, e43] = isoWeekRange('2026-W43')!;
    return [Buffer.from(HEADER + '\n' + Array.from({ length: 50_000 }, (_, i) => `SYNTHETIC,BASE,C${i},2026-W43,${s43},${e43},SAME,n,1,1,1,0,1,O,S`).join('\n') + '\n')];
  },
  five_x_50k: () => ['A', 'B', 'C', 'D', 'E'].map(p => rows(50_000, p)),
  five_x_25MiB: () => ['A', 'B', 'C', 'D', 'E'].map(p => { const b = rows(49_000, p, 200); return b; }),
  one_huge_line_25MiB: () => [Buffer.concat([Buffer.from(HEADER + '\n'), Buffer.alloc(25 * MiB - HEADER.length - 2, 0x61), Buffer.from('\n')])],
  long_field_1MiB: () => [Buffer.from(`${HEADER}\nSYNTHETIC,BASE,R1,2026-W43,2026-10-19,2026-10-25,S1,${'y'.repeat(MiB)},1,1,1,0,1,O,S\n`)],
};

if (process.argv[2] === '--child') {
  const name = process.argv[3];
  const sources = SCENARIOS[name]().map((content, i) => ({ content, versionId: `v${i}`, sha256: 'a'.repeat(64) }));
  const bytes = sources.reduce((t, s) => t + s.content.length, 0);
  const started = process.hrtime.bigint();
  const cpuStart = process.cpuUsage();
  const result = runOpsReportV1({ sources, week: '2026-W43', datasets: ['BASE'] });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const cpu = process.cpuUsage(cpuStart);
  process.stdout.write(JSON.stringify({ name, input_bytes: bytes, status: result.status, codes: result.status === 'rejected' ? [...new Set(result.errors.map(e => e.code))].slice(0, 5) : undefined,
    rows: result.status === 'completed' ? result.counts.rows : undefined, result_json_mb: Math.round(Buffer.byteLength(JSON.stringify(result)) / 1048576 * 10) / 10, ms: Math.round(ms), cpu_ms: Math.round((cpu.user + cpu.system) / 1000), max_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024) }));
} else {
  const out = process.argv[2];
  const names = process.argv.slice(3).length ? process.argv.slice(3) : Object.keys(SCENARIOS);
  const results = names.map(name => JSON.parse(execFileSync(process.execPath, [...process.execArgv, path.resolve(process.argv[1]), '--child', name], { encoding: 'utf8', maxBuffer: 1 << 20 })));
  // 契約：合法輸入必須完成、超限輸入必須以指定代碼拒收（耗時與 RSS 只記錄，不設門檻）。
  const EXPECTED: Record<string, string> = { single_50k: 'completed', same_site_conflict_50k: 'completed', five_x_10k_legal_aggregate: 'completed', five_x_50k: 'TOTAL_ROWS_EXCEEDED',
    five_x_25MiB: 'TOTAL_BYTES_EXCEEDED', one_huge_line_25MiB: 'TOTAL_BYTES_EXCEEDED', one_huge_line_20MiB: 'LINE_TOO_LONG', long_field_1MiB: 'LINE_TOO_LONG' };
  const violations = results.filter((r: { name: string; status: string; codes?: string[] }) => EXPECTED[r.name] && (EXPECTED[r.name] === 'completed' ? r.status !== 'completed' : !(r.codes ?? []).includes(EXPECTED[r.name])));
  writeFileSync(out, JSON.stringify({ node: process.version, arch: process.arch, expected: EXPECTED, violations, results }, null, 1) + '\n');
  console.log(JSON.stringify(results));
  if (violations.length) process.exitCode = 1;
}
