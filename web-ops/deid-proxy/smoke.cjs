// End-to-end self-check: runs one real chat turn through a CloudCLI server and proves the de-identification proxy
// was in the path. Exit code 0 = pass, 1 = fail (the cutover script rolls back on 1).
// usage: node smoke.cjs <cloudcli base url, e.g. http://127.0.0.1:3001> [proxy dir, default this folder]
// The turn reads smoke-ws\case.txt (made-up data), writes smoke-ws\out.txt and answers. Pass means: the reply and
// the written file carry the real values, and the proxy's audit log recorded replacing them during this turn.
'use strict';
const fs = require('fs');
const path = require('path');
const WebSocket = require('D:/TAS/cc-host/node_modules/@cloudcli-ai/cloudcli/node_modules/ws');

const BASE = process.argv[2];
const DIR = process.argv[3] || __dirname;
const WS_DIR = path.join(__dirname, 'smoke-ws');
const IP = '10.255.0.14', ID = 'A123456789', MAIL = 'smoke.check@corp-example.com.tw';
const say = (...a) => console.log(new Date().toISOString(), ...a);

(async () => {
  fs.mkdirSync(WS_DIR, { recursive: true });
  fs.writeFileSync(path.join(WS_DIR, 'case.txt'), `自檢用假資料\n主機 ${IP}\n身分證 ${ID}\n信箱 ${MAIL}\n`);
  const outFile = path.join(WS_DIR, 'out.txt');
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  const started = Date.now();

  const created = await (await fetch(`${BASE}/api/providers/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'claude', projectPath: WS_DIR, initialMessage: '去識別層自檢' }),
  })).json();
  const sessionId = created.data.sessionId;
  say('session', sessionId);

  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  let reply = '', ended = null;
  const done = new Promise((resolve) => {
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.sessionId !== sessionId) return;
      if (m.kind === 'text' && m.role === 'assistant' && !m.parentToolUseId) reply += String(m.content);
      if (['complete', 'error', 'protocol_error'].includes(m.kind)) { ended = m; resolve(); }
    });
    setTimeout(resolve, 150000);
  });
  ws.send(JSON.stringify({
    type: 'chat.send', sessionId,
    content: '讀 case.txt。用 Write 建立 out.txt，內容只有那個主機 IP 一行。然後回覆我：主機 IP、身分證字號、信箱，各一行，照檔案原文。',
    options: { model: 'haiku', permissionMode: 'bypassPermissions', toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: true }, skipPermissions: true, attachments: [] },
  }));
  await done;
  ws.close();

  const audit = fs.existsSync(path.join(DIR, 'audit.jsonl')) ? fs.readFileSync(path.join(DIR, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => Date.parse(r.t) >= started - 2000) : [];
  const replaced = audit.reduce((sum, r) => sum + (r.replaced?.IP || 0) + (r.replaced?.ID || 0) + (r.replaced?.EMAIL || 0), 0);
  const out = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  const checks = {
    'turn completed': ended?.kind === 'complete',
    'reply has the real values': [IP, ID, MAIL].every((v) => reply.includes(v)),
    'reply has no leftover alias': !/DEID_[A-Z]+_\d+/.test(reply),
    'file written by the tool has the real IP': out.includes(IP),
    'proxy saw this turn and replaced values': audit.some((r) => r.path === '/v1/messages' && r.status === 200) && replaced >= 3,
  };
  for (const [name, pass] of Object.entries(checks)) say(pass ? 'ok  ' : 'FAIL', name);
  if (ended?.kind !== 'complete') say('end frame:', JSON.stringify(ended).slice(0, 300));
  const pass = Object.values(checks).every(Boolean);
  say(pass ? 'SMOKE PASS' : 'SMOKE FAIL', `(audit entries ${audit.length}, replaced ${replaced})`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { say('SMOKE FAIL', e.message); process.exit(1); });
