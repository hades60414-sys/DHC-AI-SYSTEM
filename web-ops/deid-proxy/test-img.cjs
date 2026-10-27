// Image checks for the de-identification proxy. Offline: the "model" is a fake upstream on this machine that records
// what it receives. The check that matters: OCR of what went upstream finds none of the fake values.
// Run make-fixtures.cjs first.   usage: node test-img.cjs
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { createVault, createEngine } = require('./deid.cjs');
const { imageMask, imageMasks, lineText } = require('./imgocr.cjs');

const T = path.join(__dirname, 'testdata');
const fake = JSON.parse(fs.readFileSync(path.join(T, 'fake.json'), 'utf8'));
const b64 = (f) => fs.readFileSync(path.join(T, f)).toString('base64');
let failed = 0;
const ok = (cond, what) => { console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) failed++; };
// Digits and letters only, so OCR spacing and punctuation slips cannot hide a leak.
const norm = (s) => s.replace(/[^0-9A-Za-z@]/g, '').toLowerCase();
const leaks = (s) => Object.entries(fake).filter(([k, v]) => k !== 'unc' && (/[\u4e00-\u9fff]/.test(v) ? s.replace(/\s/g, '').includes(v) : norm(s).includes(norm(v)))).map(([k]) => k);
const img = (f, type) => ({ type: 'image', source: { type: 'base64', media_type: type, data: b64(f) } });

// OCR text of a base64 image, both engines, as one string.
function ocrText(data, ext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deidimgt-'));
  try {
    const f = path.join(dir, 'x' + ext), o = path.join(dir, 'o.json');
    fs.writeFileSync(f, Buffer.from(data, 'base64'));
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'imgocr.ps1'), 'ocr', f, o], { stdio: 'ignore', timeout: 30000 });
    return JSON.parse(fs.readFileSync(o, 'utf8')).engines.flatMap((e) => e.lines.map((l) => lineText(l).s)).join('\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

(async () => {
  const engine = createEngine({ vault: createVault(null), dictFile: null });

  // 0. The fixture really contains the values (otherwise the leak checks prove nothing)
  const before = ocrText(b64('shot.png'), '.png');
  ok(leaks(before).length >= 7, 'OCR of the unmasked screenshot finds the fake values: ' + leaks(before).join(','));

  // 1. PNG and JPEG get masked, and OCR of the result finds none of them
  for (const [f, type, ext] of [['shot.png', 'image/png', '.png'], ['shot.jpg', 'image/jpeg', '.jpg']]) {
    const t0 = Date.now();
    const r = await imageMask(b64(f), type, engine.findHits);
    const ms = Date.now() - t0;
    ok(r.kind === 'masked' && r.media_type === type, `${f} masked, stays ${type} (${r.kind}, ${r.boxes} boxes, ${ms} ms)`);
    const after = r.data ? ocrText(r.data, ext) : '';
    ok(r.data && leaks(after).length === 0, `${f}: OCR of the masked image finds no fake value (left: ${leaks(after).join(',') || 'none'})`);
    ok(/報告|資料|帳號/.test(after), `${f}: ordinary Chinese text is still readable after masking`);
    const t1 = Date.now(); const again = await imageMask(b64(f), type, engine.findHits);
    ok(again.data === r.data && Date.now() - t1 < 200, `${f}: second time comes from the cache, same bytes (${Date.now() - t1} ms)`);
  }

  // 2. Clean image unchanged; unreadable image passes and is counted
  const c = await imageMask(b64('clean.png'), 'image/png', engine.findHits);
  ok(c.kind === 'clean', 'image with nothing sensitive is left alone (' + c.kind + ')');
  const bad = await imageMask(Buffer.from('not an image').toString('base64'), 'image/png', engine.findHits);
  ok(bad.kind === 'error', 'garbage image gives kind error (' + bad.kind + ')');
  const webp = await imageMask(Buffer.from('RIFF0000WEBPVP8 fake').toString('base64'), 'image/webp', engine.findHits);
  ok(webp.kind === 'error', 'webp is not read this round (' + webp.kind + ')');

  // 2b. A face holds the image; releasing it sends the text-masked version, not the original
  const f = await imageMask(b64('face.jpg'), 'image/jpeg', engine.findHits);
  ok(f.faces >= 1, 'face picture: face found (' + f.faces + ')');
  const shotR = await imageMask(b64('shot.png'), 'image/png', engine.findHits);
  ok(shotR.faces === 0 && c.faces === 0, 'screenshots have no face');
  const fb = { model: 'm', messages: [{ role: 'user', content: [img('face.jpg', 'image/jpeg')] }] };
  const fo = engine.aliasRequest(fb, {}, { img: await imageMasks(fb, engine.findHits) }).messages[0].content[0];
  ok(fo.type === 'text' && /圖片含人臉/.test(fo.text) && /覆核放行 [0-9a-f]{8}/.test(fo.text), 'face picture held with a release code');
  const code = /覆核放行 ([0-9a-f]{8})/.exec(fo.text)[1];
  const fr = { ...fb, messages: [...fb.messages, { role: 'user', content: '覆核放行 ' + code }] };
  ok(engine.aliasRequest(fr, {}, { img: await imageMasks(fr, engine.findHits) }).messages[0].content[0].type === 'image', 'sender release lets the face picture through');

  // 3. Engine: image in a user message and inside a tool result
  const body = { model: 'm', messages: [
    { role: 'user', content: [{ ...img('shot.png', 'image/png'), cache_control: { type: 'ephemeral' } }, { type: 'text', text: '看圖' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.jpg' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [img('shot.jpg', 'image/jpeg')] }, img('clean.png', 'image/png'), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] },
  ] };
  const counts = {};
  const out = engine.aliasRequest(body, counts, { img: await imageMasks(body, engine.findHits) });
  ok(out.messages[0].content[0].source.data !== body.messages[0].content[0].source.data && out.messages[0].content[0].cache_control, 'image in a message replaced by the masked one, cache_control kept');
  ok(out.messages[2].content[0].content[0].source.data !== body.messages[2].content[0].content[0].source.data, 'image inside a tool result masked too');
  ok(out.messages[2].content[1].source.data === b64('clean.png'), 'clean image sent as it was');
  ok(out.messages[2].content[2].type === 'text' && /去識別層擋下附件：圖片（png）/.test(out.messages[2].content[2].text), 'unreadable image held with a notice');
  ok(counts.IMG_MASKED === 2 && counts.IMG_CLEAN === 1 && counts.IMAGE === 1 && counts.HELD === 1, 'counts: ' + JSON.stringify(counts));
  const again = engine.aliasRequest(body, {}, { img: await imageMasks(body, engine.findHits) });
  ok(JSON.stringify(again) === JSON.stringify(out), 'same request twice gives byte-identical output (prompt cache stays valid)');

  // 4. Through the real server.cjs, with a fake upstream
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deidimg-'));
  const got = [];
  const up = http.createServer((req, res) => {
    const ch = []; req.on('data', (x) => ch.push(x));
    req.on('end', () => { got.push(Buffer.concat(ch).toString('utf8')); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text: 'done' }] })); });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => up.once('listening', r));
  const port = 3014;
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.cjs')], { env: { ...process.env, DEID_PORT: String(port), DEID_DIR: dir, DEID_UPSTREAM: `http://127.0.0.1:${up.address().port}` }, stdio: 'ignore' });
  const get = (p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { let d = ''; r.on('data', (x) => (d += x)); r.on('end', () => res(d)); }).on('error', rej));
  for (let i = 0; i < 50; i++) { try { await get('/_deid/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const post = (b) => new Promise((res, rej) => {
    const data = JSON.stringify(b);
    const r = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (x) => { let d = ''; x.on('data', (y) => (d += y)); x.on('end', () => res({ status: x.statusCode, body: d })); });
    r.on('error', rej); r.end(data);
  });
  const t0 = Date.now();
  const r1 = await post({ model: 'm', messages: [{ role: 'user', content: [img('shot.png', 'image/png'), { type: 'text', text: 'hi' }] }] });
  ok(r1.status === 200, `screenshot request forwarded, status ${r1.status}, ${Date.now() - t0} ms`);
  const sentImg = JSON.parse(got[0]).messages[0].content[0].source.data;
  ok(sentImg !== b64('shot.png') && leaks(ocrText(sentImg, '.png')).length === 0, 'upstream got the masked image; OCR of it finds no fake value');
  await new Promise((r) => setTimeout(r, 300)); // the audit line is appended after the response ends
  const audit = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8');
  ok(JSON.parse(audit.trim().split('\n')[0]).replaced.IMG_MASKED === 1, 'audit counts IMG_MASKED');
  ok(leaks(audit).length === 0, 'audit log holds no values');
  srv.kill(); up.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
