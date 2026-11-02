// De-identification proxy for Codex (OpenAI Responses API over ChatGPT login), the twin of cc-web/deid-proxy for Claude Code.
// Codex is pointed here with a custom model provider (see README.md). Every string Codex sends in `input` is aliased with the
// same engine and dictionary as Claude Code; aliases in the streamed reply are swapped back, so tools run on real values.
// Listens on 127.0.0.1 only. A body it cannot inspect is refused, not forwarded.
// usage: node server.cjs     env: CODEX_DEID_PORT (default 3004), CODEX_DEID_UPSTREAM (default https://chatgpt.com)
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { createVault, createEngine } = require('D:/TAS/cc-web/deid-proxy/deid.cjs');

const PORT = Number(process.env.CODEX_DEID_PORT || 3004);
const UPSTREAM = new URL(process.env.CODEX_DEID_UPSTREAM || 'https://chatgpt.com');
const DIR = process.env.CODEX_DEID_DIR || __dirname;
// Own vault (one writer per file); the dictionary is shared with the Claude Code proxy.
const vault = createVault(path.join(DIR, 'vault.json'));
const engine = createEngine({ vault, dictFile: process.env.CODEX_DEID_DICT || 'D:/TAS/cc-web/deid-proxy/dictionary.txt' });
const audit = (rec) => fs.appendFile(path.join(DIR, 'audit.jsonl'), JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n', () => {});
const refuse = (res, status, why) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'deid_proxy_refused', message: 'codex-deid: ' + why } })); };

const ALIAS_HEAD = /D(E(I(D(_([A-Z]+(_(\d*)?)?)?)?)?)?)?$/;
// Keys whose values are protocol, not content: ids, enums, signed blobs, tool names.
const KEEP = new Set(['type', 'role', 'id', 'call_id', 'item_id', 'status', 'name', 'encrypted_content', 'phase', 'model', 'detail', 'namespace']);
const JSON_TEXT = new Set(['arguments']); // string fields that hold JSON text

const NOTE = 'Some values in this conversation appear as stand-in tokens of the form DEID_<KIND>_<number> (for example an IP address, a person, a path). '
  + 'Each token stands for one real value and is swapped back automatically before tools run and before the user reads your reply. '
  + 'Use each token verbatim wherever you would use the real value, and do not comment on the tokens or describe them as placeholders.';

function aliasJsonText(s, counts) {
  try { return JSON.stringify(aliasDeep(JSON.parse(s), counts)); } catch { return engine.aliasText(s, counts); }
}
function aliasDeep(v, counts, key) {
  if (typeof v === 'string') return KEEP.has(key) ? v : JSON_TEXT.has(key) ? aliasJsonText(v, counts) : engine.aliasText(v, counts);
  if (Array.isArray(v)) return v.map((x) => aliasDeep(x, counts, key));
  if (!v || typeof v !== 'object') return v;
  // Images are not OCR-checked on this path, so they never leave the machine.
  if (v.type === 'input_image') { counts.IMAGE = (counts.IMAGE || 0) + 1; return { type: 'input_text', text: '[去識別層擋下附件：圖片沒有送出。]' }; }
  if (v.type === 'input_file') { counts.FILE = (counts.FILE || 0) + 1; return { type: 'input_text', text: '[去識別層擋下附件：檔案沒有送出。]' }; }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, aliasDeep(x, counts, k)]));
}
function aliasRequest(body, counts) {
  if (!body || !Array.isArray(body.input)) throw new Error('not a responses request');
  const out = { ...body, input: aliasDeep(body.input, counts) };
  if (typeof body.instructions === 'string') out.instructions = engine.aliasText(body.instructions, counts) + '\n\n' + NOTE;
  else out.input = [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: NOTE }] }, ...out.input];
  return out;
}

function restoreDeep(v, key) {
  if (typeof v === 'string') return key === 'encrypted_content' ? v : engine.restoreText(v, JSON_TEXT.has(key));
  if (Array.isArray(v)) return v.map((x) => restoreDeep(x, key));
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, restoreDeep(x, k)]));
}
// SSE rewriter. Deltas can split an alias, so each stream (item + part) keeps a held tail until its next delta or its .done event.
function sseRestorer() {
  const tail = new Map();
  let buf = '';
  const keyOf = (d) => [d.item_id ?? d.output_index, d.content_index ?? d.summary_index ?? ''].join(':');
  const isJsonDelta = (t) => /arguments|tool_call_input/.test(t);
  const event = (raw) => {
    const m = /^data: (.*)$/m.exec(raw);
    if (!m) return raw;
    let d; try { d = JSON.parse(m[1]); } catch { return raw; }
    const t = String(d.type || '');
    let pre = '';
    if (t.endsWith('.delta') && typeof d.delta === 'string') {
      const k = keyOf(d);
      let s = (tail.get(k)?.text || '') + d.delta, held = '';
      const h = ALIAS_HEAD.exec(s); if (h && h[0]) { held = h[0]; s = s.slice(0, -held.length); }
      tail.set(k, { text: held, type: t, base: d });
      d.delta = engine.restoreText(s, isJsonDelta(t));
    } else {
      if (t.endsWith('.done')) {
        const k = keyOf(d), left = tail.get(k);
        if (left?.text) {
          const ev = { ...left.base, delta: engine.restoreText(left.text, isJsonDelta(left.type)) };
          pre = `event: ${left.type}\ndata: ${JSON.stringify(ev)}\n\n`;
        }
        tail.delete(k);
      }
      d = restoreDeep(d);
    }
    return pre + raw.replace(m[0], () => 'data: ' + JSON.stringify(d));
  };
  return (chunk, end) => {
    buf += chunk; let out = '', i;
    while ((i = buf.indexOf('\n\n')) >= 0) { out += event(buf.slice(0, i)) + '\n\n'; buf = buf.slice(i + 2); }
    if (end && buf) { out += event(buf); buf = ''; }
    return out;
  };
}

const server = http.createServer((req, res) => {
  if (req.url === '/_deid/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, vault: vault.size() })); }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    const rec = { path: req.url.split('?')[0], method: req.method };
    const counts = {};
    if (body.length) {
      if (req.headers['content-encoding']) { audit({ ...rec, refused: 'compressed body' }); return refuse(res, 415, 'compressed request bodies are not inspected'); }
      try {
        const parsed = JSON.parse(body.toString('utf8'));
        rec.model = parsed.model;
        body = Buffer.from(JSON.stringify(aliasRequest(parsed, counts)));
        vault.flush();
      } catch (e) { audit({ ...rec, refused: String(e.message) }); return refuse(res, 400, 'request could not be inspected, so it was not forwarded (' + e.message + ')'); }
    }
    const headers = { ...req.headers, host: UPSTREAM.host };
    headers['accept-encoding'] = 'identity';
    if (body.length) headers['content-length'] = String(body.length); else headers['content-length'] = undefined;
    const clean = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
    const lib = UPSTREAM.protocol === 'http:' ? http : https;
    const up = lib.request({ host: UPSTREAM.hostname, port: UPSTREAM.port || undefined, path: req.url, method: req.method, headers: clean }, (ur) => {
      const h = Object.fromEntries(Object.entries(ur.headers).filter(([k]) => k !== 'content-length'));
      res.writeHead(ur.statusCode, h);
      const sse = /event-stream/.test(ur.headers['content-type'] || '');
      const fix = sse ? sseRestorer() : null;
      let whole = '';
      ur.setEncoding('utf8');
      ur.on('data', (c) => { if (sse) res.write(fix(c, false)); else whole += c; });
      ur.on('end', () => {
        res.end(sse ? fix('', true) : engine.restoreText(whole, /json/.test(ur.headers['content-type'] || '')));
        audit({ ...rec, status: ur.statusCode, replaced: counts, vault: vault.size() });
      });
    });
    up.on('error', (e) => { audit({ ...rec, error: String(e.message) }); if (!res.headersSent) refuse(res, 502, 'upstream unreachable (' + e.message + ')'); else res.end(); });
    req.on('aborted', () => up.destroy());
    up.end(body);
  });
});
server.on('upgrade', (req, sock) => { audit({ path: req.url, refused: 'websocket upgrade' }); sock.end('HTTP/1.1 426 Upgrade Required\r\n\r\n'); })
  
if (require.main === module) server.listen(PORT, '127.0.0.1', () => console.log(`codex-deid on 127.0.0.1:${PORT} -> ${UPSTREAM.origin}, vault ${vault.size()} entries`));

module.exports = { aliasRequest, sseRestorer };
