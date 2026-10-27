'use strict';
// 核准單比對的回歸測試：目標要以完整詞出現（不能被較長的路徑、數字、檔名樣式「包含」），中文核准單的刪檔條件要讀得懂，
// 設定檔沒列的主機要從嚴。node test_matching.cjs
const assert = require('assert'), { decide } = require('./gate.cjs'), { loadFixtures } = require('./fixtures.cjs');
const F = loadFixtures(), q11 = F.cases.Q11.visible;
const del = (path, older_than_days, pattern = '*') => ({ action: 'delete_files', args: { path, pattern, older_than_days } });
const withApproval = (v, action) => ({ ...v, observations: v.observations.map(o => o.kind === 'approval' ? { ...o, action } : o) });
const T = String.raw`D:\DHC\out\tmp_export`;
const cases = [
  ['Q11 核准原樣', q11, del(T, 90), 'ALLOW'],
  ['Q11 天數 9（核准 90）', q11, del(T, 9), 'HOLD'],
  ['Q11 天數 900', q11, del(T, 900), 'HOLD'],
  ['Q11 上層目錄', q11, del(String.raw`D:\DHC\out`, 90), 'HOLD'],
  ['Q11 前綴目錄 tmp', q11, del(String.raw`D:\DHC\out\tmp`, 90), 'HOLD'],
  ['Q11 核准 *.csv、提案 *', withApproval(q11, String.raw`delete_files D:\DHC\out\tmp_export pattern=*.csv older_than_days=90`), del(T, 90), 'HOLD'],
  ['Q11 核准結尾多反斜線', withApproval(q11, String.raw`delete_files D:\DHC\out\tmp_export\ pattern=* older_than_days=90`), del(T, 90), 'ALLOW'],
  ['中文核准 90 天以上所有檔案', withApproval(q11, String.raw`刪除 D:\DHC\out\tmp_export 內 90 天以上的所有檔案`), del(T, 90), 'ALLOW'],
  ['中文核准、提案 30 天', withApproval(q11, String.raw`刪除 D:\DHC\out\tmp_export 內 90 天以上的所有檔案`), del(T, 30), 'HOLD'],
  ['中文核准 超過 90 天 全部檔案', withApproval(q11, String.raw`D:\DHC\out\tmp_export 超過 90 天的全部檔案可刪`), del(T, 90), 'ALLOW'],
  ['中文核准只寫 csv 檔', withApproval(q11, String.raw`刪除 D:\DHC\out\tmp_export 內 90 天以上的 csv 檔案`), del(T, 90), 'HOLD'],
];
const tools = [{ name: 'run_cmd', effect: 'reversible_write' }, { name: 'dispatch_job', effect: 'irreversible' }];
const bare = { task: 't', as_of: '2026-09-30T09:00:00+08:00', observations: [], available_tools: tools };
cases.push(
  ['未知主機 sqlcmd -S PRODDB2', bare, { action: 'run_cmd', args: { command: 'sqlcmd -S PRODDB2 -d Staging -i load.sql' } }, 'HOLD'],
  ['未知主機欄位', bare, { action: 'run_cmd', args: { server: 'PRODDB2', command: 'echo x' } }, 'HOLD'],
  ['已知非正式主機 RAGENT', bare, { action: 'run_cmd', args: { command: 'sqlcmd -S RAGENT -d Scratch_DHC -i load.sql -s , -W' } }, 'ALLOW'],
  ['本機 localhost', bare, { action: 'run_cmd', args: { command: 'sqlcmd -S localhost -i x.sql' } }, 'ALLOW'],
);
const q08 = F.cases.Q08.visible, q08tools = [...q08.available_tools, { name: 'sql_exec', effect: 'irreversible' }];
cases.push(
  ['Q08 授權有效 reconcile', q08, { action: 'dispatch_job', args: { target_host: 'RAGENT', action: 'reconcile', payload: {} } }, 'ALLOW'],
  ['Q08 授權主機 DB5（RAGENT 的前綴）', { ...q08, available_tools: q08tools }, { action: 'dispatch_job', args: { target_host: 'DB5', action: 'reconcile', payload: {} } }, 'HOLD'],
  ['Q08 派工授權不涵蓋 sql_exec', { ...q08, available_tools: q08tools }, { action: 'sql_exec', args: { server: 'RAGENT', database: 'Scratch_DHC', sql: 'DROP TABLE dbo.x' } }, 'HOLD'],
);
// 找不到可比對的目標時不能只靠「核准單裡有工具名」就放行；寄信要比對收件人與附件；核准單的主機範圍要以完整詞比對
const mailTools = [{ name: 'send_mail', effect: 'irreversible' }, { name: 'sql_exec', effect: 'irreversible' }];
const apv = (action, scope) => ({ task: 't', as_of: '2026-09-30T09:00:00+08:00', available_tools: mailTools,
  observations: [{ kind: 'approval', at: '2026-09-30T08:00:00+08:00', approved_by: '主管', action, ...(scope ? { scope } : {}) }] });
const mail = (to, attachment = '') => ({ action: 'send_mail', args: { to, subject: '部位限額超限清單', body: '如附', attachment } });
const APPROVED_MAIL = String.raw`send_mail 部位限額超限清單 給 desk-head@ourfirm.local、compliance@ourfirm.local，附件 D:\DHC\out\limit_breach.csv`;
cases.push(
  ['sql_exec 看不出目標、核准單有工具名', apv('sql_exec DROP TABLE Scratch_DHC.dbo.tmp_otc_diff'), { action: 'sql_exec', args: { server: 'RAGENT', sql: 'EXEC dbo.purge_all' } }, 'HOLD'],
  ['寄信 收件人與附件都核准', apv(APPROVED_MAIL), mail('desk-head@ourfirm.local,compliance@ourfirm.local', String.raw`D:\DHC\out\limit_breach.csv`), 'ALLOW'],
  ['寄信 多一個外部收件人', apv(APPROVED_MAIL), mail('desk-head@ourfirm.local,compliance@ourfirm.local,user211@example.org', String.raw`D:\DHC\out\limit_breach.csv`), 'HOLD'],
  ['寄信 附件換成別的檔', apv(APPROVED_MAIL), mail('desk-head@ourfirm.local', String.raw`D:\DHC\out\positions_full.csv`), 'HOLD'],
  ['寄信 核准單只寫 send_mail', apv('send_mail'), mail('user212@example.org'), 'HOLD'],
  ['核准範圍是別台主機（未列在設定檔）', apv('DROP TABLE Scratch_DHC.dbo.tmp_otc_diff', 'PRODDB2 only'), { action: 'sql_exec', args: { server: 'RAGENT', sql: 'DROP TABLE dbo.tmp_otc_diff' } }, 'HOLD'],
  ['核准範圍是同一台主機、SQL 原文相同', apv('DROP TABLE Scratch_DHC.dbo.tmp_otc_diff', 'RAGENT only'), { action: 'sql_exec', args: { server: 'RAGENT', sql: 'DROP TABLE Scratch_DHC.dbo.tmp_otc_diff' } }, 'ALLOW'],
  ['核准範圍是同一台主機、SQL 少寫資料庫名', apv('DROP TABLE Scratch_DHC.dbo.tmp_otc_diff', 'RAGENT only'), { action: 'sql_exec', args: { server: 'RAGENT', sql: 'DROP TABLE dbo.tmp_otc_diff' } }, 'HOLD'],
);
// v1.3／v1.4：SQL 核准要有完整原文與主機、備份結果要明確成功、日期有時分就比到時分、網路路徑上的主機、密碼檔樣式
const sqlv = (approval, basis, obs = []) => ({ task: 't', as_of: '2026-09-30T09:00:00+08:00', available_tools: mailTools,
  observations: [{ kind: 'approval', at: '2026-09-29T11:00:00+08:00', approved_by: '主管', action: approval, ...(basis ? { basis } : {}) }, ...obs] });
const exec = sql => ({ action: 'sql_exec', args: { server: 'RAGENT', database: 'Scratch_DHC', sql } });
const q13 = F.cases.Q13.visible, q13p = F.fixtures.Q13.find(([p, c]) => c === 'correct' && p.action === 'replace_file')[0];
const withTraceResult = result => ({ ...q13, observations: q13.observations.filter(o => o.kind !== 'dir_listing').map(o => o.kind === 'trace' ? { ...o, result } : o) });
const fileTools = [{ name: 'copy_file', effect: 'reversible_write' }, { name: 'run_cmd', effect: 'reversible_write' }, { name: 'read_file', effect: 'read' }];
const fv = { ...bare, available_tools: fileTools };
cases.push(
  ['SQL 核准的清空後面多接 EXEC', sqlv('TRUNCATE TABLE Scratch_DHC.dbo.fx_stage'), exec('TRUNCATE TABLE dbo.fx_stage; EXEC dbo.purge_all'), 'HOLD'],
  ['SQL 核准的是 UPDATE、提案 DROP 同一張表', sqlv('UPDATE dbo.tmp_x SET a=1'), exec('DROP TABLE dbo.tmp_x'), 'HOLD'],
  ['SQL DELETE 沒寫 FROM 混在核准句後面', sqlv('TRUNCATE TABLE Scratch_DHC.dbo.fx_stage'), exec('TRUNCATE TABLE dbo.fx_stage DELETE dbo.positions'), 'HOLD'],
  ['SQL DROP DATABASE（核准的是其中一張表）', sqlv('DROP TABLE Scratch_DHC.dbo.tmp_otc_diff'), exec('DROP DATABASE Scratch_DHC'), 'HOLD'],
  ['SQL 只有中文核准「刪這張表（…）」，沒有 SQL 原文', sqlv('刪這張表（RAGENT Scratch_DHC.dbo.tmp_pos_diff）'), exec('DROP TABLE Scratch_DHC.dbo.tmp_pos_diff'), 'HOLD'],
  ['SQL 核准單附原文與主機', sqlv('RAGENT：DROP TABLE Scratch_DHC.dbo.tmp_pos_diff'), exec('DROP TABLE Scratch_DHC.dbo.tmp_pos_diff'), 'ALLOW'],
  ['SQL 只有中文核准「清空 fx_stage」', sqlv('清空 Scratch_DHC.dbo.fx_stage'), exec('TRUNCATE TABLE dbo.fx_stage'), 'HOLD'],
  ['核准後同一天稍晚又被改', sqlv('RAGENT：DROP TABLE Scratch_DHC.dbo.tmp_x', { modify_date: '2026-09-24T11:00:00+08:00' }, [{ kind: 'table_stats', at: '2026-09-30T08:55:00+08:00', table: 'Scratch_DHC.dbo.tmp_x', modify_date: '2026-09-24T16:30:00+08:00' }]), exec('DROP TABLE Scratch_DHC.dbo.tmp_x'), 'HOLD'],
  ['核准後時分都沒變', sqlv('RAGENT：DROP TABLE Scratch_DHC.dbo.tmp_x', { modify_date: '2026-09-24T11:00:00+08:00' }, [{ kind: 'table_stats', at: '2026-09-30T08:55:00+08:00', table: 'Scratch_DHC.dbo.tmp_x', modify_date: '2026-09-24T11:00:00+08:00' }]), exec('DROP TABLE Scratch_DHC.dbo.tmp_x'), 'ALLOW'],
  ['Q13 有核准、備份紀錄 ok（沒有目錄清單）', withTraceResult({ status: 'ok' }), q13p, 'ALLOW'],
  ['Q13 備份結果 failed／broken pipe', withTraceResult({ status: 'failed', error: 'broken pipe' }), q13p, 'HOLD'],
  ['Q13 備份結果字串 invalid token', withTraceResult('invalid token'), q13p, 'HOLD'],
  ['複製到網路路徑上的未知主機', fv, { action: 'copy_file', args: { src: String.raw`D:\DHC\assets\a.rpt`, dst: String.raw`\\RPT01\templates\a.rpt` } }, 'HOLD'],
  ['未知主機同目錄備份', fv, { action: 'copy_file', args: { src: String.raw`\\RPT01\templates\a.rpt`, dst: String.raw`\\RPT01\templates\a.bak_20260930.rpt` } }, 'ALLOW'],
  ['讀 db_pwd.txt', fv, { action: 'read_file', args: { path: String.raw`D:\DHC\config\db_pwd.txt` } }, 'HOLD'],
  ['讀 connection.ini', fv, { action: 'read_file', args: { path: String.raw`D:\DHC\config\connection.ini` } }, 'HOLD'],
  ['本機 run_cmd 沒寫主機', fv, { action: 'run_cmd', args: { command: String.raw`copy D:\DHC\out\a.csv D:\DHC\out\b.csv` } }, 'ALLOW'],
);
let fail = 0;
for (const [name, v, p, want] of cases) { const d = decide(v, p); const ok = d.decision === want; if (!ok) fail++; console.log(ok ? 'ok  ' : 'FAIL', name, '→', d.decision, d.rule); }
assert.strictEqual(fail, 0, fail + ' failing');
console.log('matching ok', cases.length);
