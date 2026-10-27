#!/usr/bin/env node
'use strict';
// ragent-mcp.cjs 的協定測試：啟動伺服器、走一遍 initialize／tools/list／參數檢查／錯誤處理。
// 加 --live 會真的經通道問 srv-db 一題（RAG-003，VaR 怎麼算），要確定沒有別的工作在跑。
//   node test-ragent-mcp.cjs [--live]
const { spawn } = require('child_process'), path = require('path');
const live = process.argv.includes('--live');
// 2026-10-01：非 --live 時把控制程式釘在 V3，版本閘門一定關著，「應該被拒絕」的案例才不會真的送到 srv-db（srv-db 升到 v3.1 後曾因此送出 seq 1435、1436）。
const pin = name => ({ ...process.env, RAGENT_CONTROLLER: path.join(__dirname, '..', name) });
const srv = spawn(process.execPath, [path.join(__dirname, 'ragent-mcp.cjs')], { stdio: ['pipe', 'pipe', 'pipe'], env: live ? process.env : pin('Controller-V3.ps1') });
let buf = ''; const waiting = new Map();
srv.stdout.setEncoding('utf8');
srv.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } } });
srv.stderr.on('data', d => process.stderr.write(d));
let nextId = 1;
const call = (method, params) => new Promise(res => { const id = nextId++; waiting.set(id, res); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const tool = (name, args) => call('tools/call', { name, arguments: args });
let failed = 0; const check = (ok, what, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + what + (ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 400))); if (!ok) failed++; };
(async () => {
  const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  check(init.result && init.result.serverInfo.name === 'ragent' && init.result.capabilities.tools, 'initialize', init);
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await call('tools/list', {});
  const names = list.result.tools.map(t => t.name);
  check(['ragent_status', 'ragent_doc_qa', 'ragent_job_result', 'ragent_health', 'ragent_file_info', 'ragent_list_dir', 'ragent_file_hash', 'ragent_doc_list', 'ragent_doc_index', 'ragent_sql', 'ragent_task_list', 'ragent_file_tail', 'ragent_sandbox'].every(n => names.includes(n)), 'tools/list has all tools', names);
  check(list.result.tools.every(t => t.inputSchema && t.inputSchema.type === 'object'), 'every tool has an object input schema', null);
  const st = await tool('ragent_status', {});
  check(!st.result.isError && /配對：已配對/.test(st.result.content[0].text) && /版本 v3/.test(st.result.content[0].text), 'ragent_status reads pairing and the latest heartbeat', st);
  const badIdx = await tool('ragent_doc_qa', { question: 'x', index: 'Bad Name' });
  check(badIdx.result.isError && /參數不對/.test(badIdx.result.content[0].text), 'ragent_doc_qa rejects a bad index name without submitting', badIdx);
  const badHist = await tool('ragent_doc_qa', { question: 'x', index: 'synthetic', history: [{ role: 'system', content: 'x' }] });
  check(badHist.result.isError && /history/.test(badHist.result.content[0].text), 'ragent_doc_qa rejects a bad history turn', badHist);
  const badQ = await tool('ragent_doc_qa', { question: 'x', index: 'synthetic', queries: ['a', 'b', 'c', 'd'] });
  check(badQ.result.isError && /queries/.test(badQ.result.content[0].text), 'ragent_doc_qa rejects more than 3 search queries', badQ);
  const qOnV3 = await tool('ragent_doc_qa', { question: 'x', index: 'synthetic', queries: ['保存期限'] });
  check(qOnV3.result.isError && /v3\.1/.test(qOnV3.result.content[0].text), 'search queries are refused while the controller is V3', qOnV3);
  const v31 = await tool('ragent_doc_list', {});
  check(v31.result.isError && /v3\.1/.test(v31.result.content[0].text), 'v3.1-only tools refuse while the controller is V3', v31);
  const sqlV3 = await tool('ragent_sql', { action: 'ping' });
  check(sqlV3.result.isError && /v3\.2/.test(sqlV3.result.content[0].text), 'ragent_sql refuses while the controller is below V32', sqlV3);
  for (const [name, args] of [['ragent_task_list', {}], ['ragent_file_tail', { path: 'C:\\x.log' }]]) {
    const r = await tool(name, args);
    check(r.result.isError && /v3\.2/.test(r.result.content[0].text), name + ' refuses while the controller is below V32', r);
  }
  for (const args of [{ action: 'list' }, { action: 'pack', spec: { package: 'mvpractice' } }]) {
    const r = await tool('ragent_sandbox', args);
    check(r.result.isError && /v3\.3/.test(r.result.content[0].text), 'ragent_sandbox ' + args.action + ' refuses while the controller is below V33', r);
  }
  const fpV3 = await tool('ragent_sql', { action: 'fingerprint', spec: { database: 'x' } });
  check(fpV3.result.isError, 'ragent_sql fingerprint refuses below V33', fpV3);
  const tailNoPath = await tool('ragent_file_tail', {});
  check(tailNoPath.result.isError, 'ragent_file_tail requires a path', tailNoPath);
  const unknown = await tool('nope', {});
  check(unknown.error && unknown.error.code === -32602, 'unknown tool is a JSON-RPC error', unknown);
  const method = await call('bogus/method', {});
  check(method.error && method.error.code === -32601, 'unknown method is a JSON-RPC error', method);
  if (live) {
    const t0 = Date.now();
    const qa = await tool('ragent_doc_qa', { question: 'VaR limit 用的 VaR 是怎麼算的？信賴水準跟觀察期是多少？', index: 'synthetic', as_of: '2026-09-26', wait_seconds: 240 });
    const text = qa.result.content[0].text;
    console.log('---- live answer (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s) ----\n' + text + '\n----');
    check(!qa.result.isError && /狀態：有答案/.test(text) && /250/.test(text) && /FAQ-LIM-021#03/.test(text), 'live ragent_doc_qa answers RAG-003 through the channel', text);
  }
  srv.stdin.end();
  console.log(`RESULT failed=${failed}`); process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; srv.kill(); });
