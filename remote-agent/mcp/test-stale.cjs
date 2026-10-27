#!/usr/bin/env node
'use strict';
// 2026-10-04 離線快速判斷：卡住超過門檻的工作，送出類工具與 ragent_job_result 要在約 10 秒內回「沒有回應、可能離線」，
// 沒卡太久時維持原本的說法。用暫存狀態資料夾＋不存在的代理程式名稱，不會呼叫控制程式、不會碰真的 srv-db／RAG1。
//   node test-stale.cjs
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stale-')), file = path.join(dir, 'controller-state.json');
const writeState = ageMin => {
  fs.writeFileSync(file, JSON.stringify({ Version: 1, Agent: 'stale-test', PendingJob: 'job-1', PendingAction: 'doc-retrieve', Seq: 77, LastFinalSeq: 76, LastResult: null }));
  const t = new Date(Date.now() - ageMin * 60000); fs.utimesSync(file, t, t);
};
const start = () => {
  const srv = spawn(process.execPath, [path.join(__dirname, 'ragent-mcp.cjs')], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, RAGENT_AGENT: 'stale-test-agent', RAGENT_LABEL: 'RAG1', RAGENT_MINOR: '1', RAGENT_RETRIEVE: '1', RAGENT_STATE_DIR: dir, RAGENT_CONTROLLER: path.join(__dirname, '..', 'Controller-V3.ps1') } });
  let buf = ''; const waiting = new Map(); let id = 0;
  srv.stdout.setEncoding('utf8');
  srv.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } } });
  const call = (method, params) => new Promise(res => { const n = ++id; waiting.set(n, res); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  return { srv, tool: async (name, args) => { const t0 = Date.now(), m = await call('tools/call', { name, arguments: args }); return { ...m.result, ms: Date.now() - t0 }; }, call };
};
let failed = 0; const check = (ok, what, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + what + (ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 300))); if (!ok) failed++; };
(async () => {
  writeState(120);
  let s = start(); await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  const r1 = await s.tool('ragent_doc_retrieve', { question: '超限怎麼處理', index: 'rules' });
  check(r1.isError && /沒有回應/.test(r1.content[0].text) && /seq 77/.test(r1.content[0].text) && r1.ms < 20000, 'stale pending job: retrieve reports offline within 20 s', r1);
  const r2 = await s.tool('ragent_job_result', {});
  check(r2.isError && /可能離線/.test(r2.content[0].text) && r2.ms < 20000, 'stale pending job: job_result reports offline within 20 s', r2);
  s.srv.kill();
  writeState(2);
  s = start(); await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  const r3 = await s.tool('ragent_job_result', { wait_seconds: 5 });
  check(!r3.isError && /還沒有結果（seq 77）/.test(r3.content[0].text), 'fresh pending job: job_result keeps the old wording', r3);
  s.srv.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed'); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(1); });
