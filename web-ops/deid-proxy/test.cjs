// node test.cjs — engine checks plus a full pass through server.cjs against a fake model server.
'use strict';
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createVault, createEngine, twIdOk } = require('./deid.cjs');

const ok = (c, n) => { assert.ok(c, n); console.log('ok', n); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deid-test-'));
fs.writeFileSync(path.join(dir, 'dictionary.txt'), '# test\nNAME 王大同\nORG 某證券\nDB TRADE_DB\nHOST fs-main\n');
const fresh = () => createEngine({ vault: createVault(null), dictFile: path.join(dir, 'dictionary.txt') });

const SECRETS = {
  ID: 'A123456789', EMP: 'E0000000', EMAIL: 'wang.dt@example-bank.com.tw', PHONE: '0912-345-678', IP: '10.255.0.10',
  IP2: '10.255.0.18', IP3: '10.255.0.13', PATH: '\\\\10.255.0.10\\htdocs', NAME: '王大同', ORG: '某證券', DB: 'TRADE_DB',
  KEY: 'sk-ant-EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE', PW: 'Sup3rSecret!x',
};
const TEXT = `客戶 ${SECRETS.NAME}（${SECRETS.ID}，員編 ${SECRETS.EMP}）信箱 ${SECRETS.EMAIL} 手機 ${SECRETS.PHONE}。
主機 ${SECRETS.IP}、${SECRETS.IP2}、${SECRETS.IP3}，檔案在 ${SECRETS.PATH}\\q3.xlsx，資料表 ${SECRETS.DB}.dbo.Pos，公司 ${SECRETS.ORG}證券。
連線字串 Server=x;Password=${SECRETS.PW}; 金鑰 ${SECRETS.KEY}`;

// --- engine ---
{
  const e = fresh(); const counts = {};
  const out = e.aliasText(TEXT, counts);
  for (const [k, v] of Object.entries(SECRETS)) ok(!out.includes(v), `outbound text has no ${k}`);
  ok(e.restoreText(out, false) === TEXT, 'restore gives back the exact original');
  ok(e.aliasText(TEXT) === out, 'same value always gets the same alias');
  ok(e.aliasText(`再次提到 ${SECRETS.PW}（沒有 password= 前綴）`).includes(SECRETS.PW) === false, 'a known secret is replaced wherever it reappears');
}
{
  const e = fresh();
  const keep = ['版本 10.0.26200', '127.0.0.1:3001', '8.8.8.8', 'password: string', 'pwd = getPassword()', 'TRADE_DB2', 'A123456788', '2026-10-08 15:04:05', '1791442489784'];
  for (const s of keep) ok(e.aliasText(s) === s, `left alone: ${s}`);
  ok(twIdOk('A123456789') && !twIdOk('A123456788'), 'ID checksum');
  ok(e.aliasText('trade_db 與 Trade_Db') !== 'trade_db 與 Trade_Db' && e.restoreText(e.aliasText('trade_db 與 Trade_Db'), false) === 'trade_db 與 Trade_Db', 'dictionary ignores case and restores the original casing');
  const lit = '文件裡本來就寫著 DEID_IP_1 這幾個字';
  const a = e.aliasText('主機 10.255.0.10'); const b = e.aliasText(lit);
  ok(!b.includes('DEID_IP_1 ') && e.restoreText(b, false) === lit && e.restoreText(a, false) === '主機 10.255.0.10', 'text that already looks like an alias survives a round trip');
}
{
  const e = fresh(); const counts = {};
  const req = {
    model: 'm', system: [{ type: 'text', text: `cwd on ${SECRETS.IP}`, cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'mcp__TRADE_DB__query', description: `Query ${SECRETS.DB} on ${SECRETS.IP}`, input_schema: { type: 'object', properties: { TRADE_DB: { type: 'string', description: `name in ${SECRETS.DB}` } } } }],
    messages: [
      { role: 'user', content: TEXT },
      { role: 'assistant', content: [{ type: 'thinking', thinking: `about ${SECRETS.IP}`, signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: SECRETS.PATH, nested: { a: [SECRETS.EMAIL] } } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: TEXT }, { type: 'image', source: { type: 'base64', data: 'AAAA' } }] }, { type: 'text', text: SECRETS.NAME }] },
    ],
  };
  const out = e.aliasRequest(req, counts);
  const flat = JSON.stringify(out);
  const leaked = Object.entries(SECRETS).filter(([, v]) => flat.includes(v) || flat.includes(JSON.stringify(v).slice(1, -1))).map(([k]) => k);
  // The thinking block is signed and goes back untouched; the tool name and schema key are identifiers the client matches on.
  assert.deepEqual(leaked.sort(), ['DB', 'IP'].sort()); console.log('ok request body: only the signed thinking block and tool identifiers keep real text');
  ok(out.messages[1].content[0].thinking === `about ${SECRETS.IP}` && out.messages[1].content[0].signature === 'sig', 'thinking block untouched');
  ok(out.tools[0].name === 'mcp__TRADE_DB__query' && 'TRADE_DB' in out.tools[0].input_schema.properties && !out.tools[0].description.includes(SECRETS.DB), 'tool name and schema keys kept, descriptions aliased');
  ok(out.system[0].cache_control && out.system.length === 2 && /DEID_<KIND>/.test(out.system[1].text), 'system keeps its cache marker and gains the note');
  ok(counts.HELD === 1 && counts.IMAGE === 1, 'image without an OCR result is held and counted');
  ok(JSON.stringify(e.aliasRequest(req)) === flat, 'aliasing the same request twice gives identical bytes (prompt cache stays valid)');
  // Names (surname + title / after a label) and business amounts; ordinary numbers and title words stay
  for (const [t, kind] of [['請王小明經理確認', 'NAME'], ['承辦人：陳美玲', 'NAME'], ['今日損益 -1,234,567 元', 'AMT'], ['部位市值 3.5億', 'AMT'], ['金額：98765', 'AMT'], ['price 1234.5678', 'AMT'], ['NT$ 50,000', 'AMT'], ['保證金(12,345)', 'AMT']]) {
    const c = {}; e.aliasText(t, c); ok(c[kind] === 1 && Object.keys(c).length === 1, kind + ' found in a ' + t.length + '-char case');
  }
  for (const t of ['line 42, port 3003, 日期 20261022, 代號 2330', '總經理同意', 'timeout: 30000', 'v1.2.3', '部門經理開會', 'const x = 0.5;', '2026-10-22 17:40']) {
    const c = {}; ok(e.aliasText(t, c) === t, 'left alone: a ' + t.length + '-char case');
  }
  // Project codes after a project label; the word 專案/project alone stays
  for (const [t, n] of [['專案代號：ALPHA7', 1], ['案號 PRJ-2026-031', 1], ['Project code: Falcon', 1], ['專案：Orion', 1], ['這個專案很急', 0], ['專案資料夾', 0], ['project folder', 0], ['the project is late', 0]]) {
    const c = {}; e.aliasText(t, c); ok((c.PROJ || 0) === n, 'PROJ count ' + n + ' for a ' + t.length + '-char case');
  }
  assert.throws(() => e.aliasRequest({ foo: 1 })); console.log('ok a body that is not a messages request is rejected');
}
{
  const e = fresh();
  const real = `請連 ${SECRETS.IP} 讀 ${SECRETS.PATH}\\a.txt 給 ${SECRETS.NAME}`;
  const aliased = e.aliasText(real);
  let bad = 0;
  for (let i = 0; i <= aliased.length; i++) for (const j of [i, Math.min(aliased.length, i + 3)]) {
    const fix = e.sseRestorer();
    const ev = (text) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`;
    const stream = ev(aliased.slice(0, i)) + ev(aliased.slice(i, j)) + ev(aliased.slice(j)) + `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`;
    let out = ''; for (let k = 0; k < stream.length; k += 37) out += fix(stream.slice(k, k + 37), false); out += fix('', true);
    const text = out.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).filter((d) => d.delta).map((d) => d.delta.text).join('');
    if (text !== real) bad++;
  }
  ok(bad === 0, 'streamed text restores exactly for every split position');
  const input = { command: `type "${SECRETS.PATH}\\a.txt"`, note: SECRETS.NAME };
  const aliasedJson = JSON.stringify({ command: e.aliasText(input.command), note: e.aliasText(input.note) });
  bad = 0;
  for (let i = 0; i <= aliasedJson.length; i++) {
    const fix = e.sseRestorer();
    const ev = (partial_json) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json } })}\n\n`;
    const out = fix(ev(aliasedJson.slice(0, i)) + ev(aliasedJson.slice(i)) + `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n`, true);
    const json = out.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).filter((d) => d.delta).map((d) => d.delta.partial_json).join('');
    try { assert.deepEqual(JSON.parse(json), input); } catch { bad++; }
  }
  ok(bad === 0, 'streamed tool arguments restore to the real values for every split position');
}
{
  const file = path.join(dir, 'vault.json');
  const v1 = createVault(file); const a = v1.aliasFor('IP', '10.255.0.10'); v1.flush();
  const v2 = createVault(file);
  ok(v2.aliasFor('IP', '10.255.0.10') === a && v2.realFor(a) === '10.255.0.10' && v2.aliasFor('IP', '10.255.0.20') !== a, 'vault survives a restart with the same aliases');
  fs.unlinkSync(file);
}

// --- through the server, against a fake model ---
(async () => {
  const seen = [];
  const fake = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: b });
      if (!b) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
      const sent = JSON.parse(b);
      const all = JSON.stringify(sent);
      const ip = /DEID_IP_\d+/.exec(all)[0], who = /DEID_NAME_\d+/.exec(all)[0], p = /DEID_PATH_\d+/.exec(all)[0];
      if (!sent.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ content: [{ type: 'text', text: `non-stream ${ip} ${p}` }] })); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (d) => `event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`;
      const half = Math.floor(ip.length / 2);
      const parts = [
        ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `主機是 ${ip.slice(0, half)}` } }),
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${ip.slice(half)}，聯絡 ${who}` } }),
        ev({ type: 'content_block_stop', index: 0 }),
        ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't', name: 'Bash', input: {} } }),
        ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: `{"command":"dir ${p.slice(0, 7)}` } }),
        ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: `${p.slice(7)}"}` } }),
        ev({ type: 'content_block_stop', index: 1 }),
      ].join('');
      let i = 0; const t = setInterval(() => { res.write(parts.slice(i, i + 23)); i += 23; if (i >= parts.length) { clearInterval(t); res.end(); } }, 1);
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const port = 39000 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, [path.join(__dirname, 'server.cjs')], { env: { ...process.env, DEID_PORT: String(port), DEID_UPSTREAM: `http://127.0.0.1:${fake.address().port}`, DEID_DIR: dir }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => child.stdout.once('data', r));
  const B = `http://127.0.0.1:${port}`;
  try {
    const post = (p, body, raw) => fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok' }, body: raw ?? JSON.stringify(body) });
    const msg = (stream) => ({ model: 'm', stream, messages: [{ role: 'user', content: TEXT }] });
    let r = await post('/v1/messages?beta=true', msg(true));
    const sse = await r.text();
    const events = sse.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    const text = events.filter((d) => d.delta?.type === 'text_delta').map((d) => d.delta.text).join('');
    const args = JSON.parse(events.filter((d) => d.delta?.type === 'input_json_delta').map((d) => d.delta.partial_json).join(''));
    ok(text === `主機是 ${SECRETS.IP}，聯絡 ${SECRETS.NAME}`, 'reply text reaches the client with real values');
    ok(args.command === `dir ${SECRETS.PATH}`, 'tool arguments reach the client with real values');
    const up = seen.at(-1);
    ok(Object.values(SECRETS).every((v) => !up.body.includes(v) && !up.body.includes(JSON.stringify(v).slice(1, -1))), 'nothing sensitive reached the model server');
    ok(up.auth === 'Bearer tok' && up.url === '/v1/messages?beta=true', 'login header and path are forwarded as sent');
    r = await post('/v1/messages', msg(false));
    ok((await r.json()).content[0].text === `non-stream ${SECRETS.IP} ${SECRETS.PATH}`, 'non-streaming reply is restored and still valid JSON');
    const before = seen.length;
    r = await post('/v1/messages', null, '{not json'); ok(r.status === 400 && seen.length === before, 'unreadable body is refused and never forwarded');
    r = await post('/v1/files', { a: SECRETS.ID }); ok(r.status === 403 && seen.length === before, 'a path the proxy does not inspect is refused and never forwarded');
    r = await fetch(B + '/api/hello', { method: 'HEAD' }); ok(r.status === 200, 'body-less requests pass through');
    r = await fetch(B + '/_deid/health'); ok((await r.json()).ok === true, 'health endpoint answers');
    const log = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8');
    ok(/"replaced":\{[^}]*"IP":3/.test(log) && Object.values(SECRETS).every((v) => !log.includes(v)), 'audit log has counts and none of the values');
    ok(Object.values(SECRETS).every((v) => fs.readFileSync(path.join(dir, 'vault.json'), 'utf8').includes(JSON.stringify(v).slice(1, -1))), 'vault on disk holds the mapping');
    console.log('ALL PASS');
  } finally { child.kill(); fake.close(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
