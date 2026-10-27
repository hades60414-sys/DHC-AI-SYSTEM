// PDF checks for the de-identification proxy. Offline: the "model" is a fake upstream on this machine that records
// what it receives. Run make-fixtures.cjs first.   usage: node test-pdf.cjs
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { createVault, createEngine } = require('./deid.cjs');
const { pdfText, pdfTexts, stop } = require('./pdftext.cjs');

const T = path.join(__dirname, 'testdata');
const fake = JSON.parse(fs.readFileSync(path.join(T, 'fake.json'), 'utf8'));
const b64 = (f) => fs.readFileSync(path.join(T, f)).toString('base64');
let failed = 0;
const ok = (cond, what) => { console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) failed++; };
const leaks = (s) => Object.entries(fake).filter(([, v]) => s.includes(v) || s.includes(JSON.stringify(v).slice(1, -1))).map(([k]) => k);
const doc = (f, extra = {}) => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(f) }, ...extra });

(async () => {
  // 1. Text extraction
  const t = await pdfText(b64('text.pdf'));
  ok(t.kind === 'text' && t.pages === 2, `text.pdf read as text, 2 pages (got ${t.kind}, ${t.pages})`);
  ok(t.text.includes('測試報告') && t.text.includes(fake.id) && t.text.includes(fake.ip), 'Chinese text and the fake values come out of the text layer');
  ok(t.text.includes('--- 第 2 頁 ---') && t.text.split('--- 第 2 頁 ---')[1].includes(fake.id), 'page 2 text is there');
  const t2 = await pdfText(b64('text.pdf'));
  ok(t2.cached === true && t2.text === t.text, 'same file again comes from the cache, same text');
  const s = await pdfText(b64('scan.pdf'));
  ok(s.kind === 'scan', `image-only page counts as a scan (got ${s.kind})`);
  const bl = await pdfText(b64('blank2.pdf'));
  ok(bl.kind === 'text' && bl.text.includes(fake.emp), `a blank page does not make it a scan (got ${bl.kind})`);
  const bad = await pdfText(Buffer.from('not a pdf at all').toString('base64'));
  ok(bad.kind === 'error', `garbage gives kind error (got ${bad.kind})`);

  // 2. Engine: PDF in a user message and inside a tool result
  const engine = createEngine({ vault: createVault(null), dictFile: null });
  const body = {
    model: 'm', system: [{ type: 'text', text: 'sys' }],
    messages: [
      { role: 'user', content: [doc('text.pdf', { title: '測試報告.pdf', cache_control: { type: 'ephemeral' }, citations: { enabled: true } }), { type: 'text', text: '請摘要' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'x.pdf' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [doc('blank2.pdf')] }] },
      { role: 'user', content: [doc('scan.pdf'), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] },
    ],
  };
  const counts = {};
  const out = engine.aliasRequest(body, counts, { pdf: await pdfTexts(body) });
  const first = out.messages[0].content[0];
  ok(first.type === 'text' && !first.source && !first.citations, 'text PDF became a text block (no source, no citations param)');
  ok(first.cache_control && first.cache_control.type === 'ephemeral', 'cache_control kept on the replacement block');
  ok(first.text.startsWith('[PDF 附件「測試報告.pdf」，共 2 頁'), 'header names the file and page count');
  ok(/DEID_ID_\d+/.test(first.text) && /DEID_IP_\d+/.test(first.text) && /DEID_SECRET_\d+/.test(first.text), 'values in the PDF became aliases (ID, IP, SECRET)');
  const tr = out.messages[2].content[0].content[0];
  ok(tr.type === 'text' && /DEID_EMP_\d+/.test(tr.text), 'PDF inside a tool result became aliased text');
  const scanHeld = out.messages[3].content[0];
  ok(scanHeld.type === 'text' && scanHeld.text.startsWith('[去識別層擋下附件：掃描版 PDF') && /覆核放行 [0-9a-f]{8}/.test(scanHeld.text), 'scan PDF is held: the model gets a notice with a release code, not the file');
  ok(!JSON.stringify(out).includes(b64('scan.pdf')), 'the scan PDF bytes are not in the outgoing request');
  const sent = JSON.stringify(out.messages.slice(0, 3));
  ok(leaks(sent).length === 0, 'no fake value left in the converted messages: ' + (leaks(sent).join(',') || 'none'));
  ok(counts.PDF_TEXT === 2 && counts.PDF_SCAN === 1 && counts.IMAGE === 1 && counts.HELD === 2, 'counts: ' + JSON.stringify(counts));
  const again = engine.aliasRequest(body, {}, { pdf: await pdfTexts(body) });
  ok(JSON.stringify(again) === JSON.stringify(out), 'same request twice gives byte-identical output (prompt cache stays valid)');
  const noMap = {};
  ok(engine.aliasRequest(body, noMap).messages[0].content[0].type === 'text' && noMap.PDF_UNREAD === 3 && noMap.HELD === 4, 'without the PDF map, PDFs are held and count as PDF_UNREAD');
  // Release: only the sender's own text counts, and only for the attachment whose code they typed
  const code = /覆核放行 ([0-9a-f]{8})/.exec(scanHeld.text)[1];
  const viaTool = { ...body, messages: [...body.messages, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '覆核放行 ' + code }] }] };
  ok(engine.aliasRequest(viaTool, {}, { pdf: await pdfTexts(body) }).messages[3].content[0].type === 'text', 'release code inside a tool result does not release');
  const wrong = { ...body, messages: [...body.messages, { role: 'user', content: '覆核放行 00000000' }] };
  ok(engine.aliasRequest(wrong, {}, { pdf: await pdfTexts(body) }).messages[3].content[0].type === 'text', 'a different code does not release');
  const rel = {}, okBody = { ...body, messages: [...body.messages, { role: 'user', content: [{ type: 'text', text: '看過了，覆核放行 ' + code }] }] };
  const relOut = engine.aliasRequest(okBody, rel, { pdf: await pdfTexts(body) });
  ok(relOut.messages[3].content[0].type === 'document' && relOut.messages[3].content[1].type === 'text' && rel.RELEASED === 1 && rel.HELD === 1, 'sender typing the code releases that scan PDF only (the unread image stays held)');
  stop();

  // 3. Through the real server.cjs, with a fake upstream
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deidpdf-'));
  let got = [];
  const up = http.createServer((req, res) => {
    const c = []; req.on('data', (x) => c.push(x));
    req.on('end', () => { got.push(Buffer.concat(c).toString('utf8')); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text: 'done' }] })); });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => up.once('listening', r));
  const port = 3013;
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.cjs')], { env: { ...process.env, DEID_PORT: String(port), DEID_DIR: dir, DEID_UPSTREAM: `http://127.0.0.1:${up.address().port}` }, stdio: 'ignore' });
  const get = (p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { let d = ''; r.on('data', (x) => (d += x)); r.on('end', () => res(d)); }).on('error', rej));
  for (let i = 0; i < 50; i++) { try { await get('/_deid/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const post = (b) => new Promise((res, rej) => {
    const data = JSON.stringify(b);
    const r = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (x) => { let d = ''; x.on('data', (y) => (d += y)); x.on('end', () => res({ status: x.statusCode, body: d })); });
    r.on('error', rej); r.end(data);
  });
  const big = { model: 'm', messages: [{ role: 'user', content: [doc('big.pdf'), { type: 'text', text: 'hi' }] }] };
  const t0 = Date.now();
  let healthMs = [];
  const probing = (async () => { while (Date.now() - t0 < 1500) { const h0 = Date.now(); await get('/_deid/health'); healthMs.push(Date.now() - h0); await new Promise((r) => setTimeout(r, 50)); } })();
  const r1 = await post(big);
  const firstMs = Date.now() - t0;
  await probing;
  ok(r1.status === 200, 'big PDF request forwarded, status ' + r1.status + `, ${firstMs} ms`);
  ok(Math.max(...healthMs) < 500, `proxy kept answering while reading 300 pages (slowest health ${Math.max(...healthMs)} ms over ${healthMs.length} probes)`);
  const g1 = JSON.parse(got[0]);
  ok(g1.messages[0].content[0].type === 'text' && !got[0].includes('application/pdf'), 'upstream got text, not the PDF');
  ok(!got[0].includes(fake.ip) && /DEID_IP_\d+/.test(got[0]), 'upstream saw the alias, not the IP');
  const t1 = Date.now(); await post(big); const secondMs = Date.now() - t1;
  ok(got[1] === got[0], `second send of the same PDF is identical upstream (${secondMs} ms vs ${firstMs} ms first time)`);
  await post({ model: 'm', messages: [{ role: 'user', content: [doc('scan.pdf')] }] });
  ok(!got[2].includes('application/pdf') && got[2].includes('去識別層擋下附件'), 'scan PDF held at the server: upstream got the notice, not the PDF');
  await new Promise((r) => setTimeout(r, 300)); // the audit line is appended after the response ends
  const audit = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  ok(audit[0].replaced.PDF_TEXT === 1 && audit[2].replaced.PDF_SCAN === 1 && audit[2].replaced.HELD === 1, 'audit counts PDF_TEXT, PDF_SCAN and HELD');
  ok(leaks(fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8')).length === 0, 'audit log holds no values');
  srv.kill(); up.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
