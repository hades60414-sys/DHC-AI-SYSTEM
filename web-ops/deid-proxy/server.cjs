// Model proxy for DHC CLI: Claude Code is pointed here with ANTHROPIC_BASE_URL, and every request to the model
// passes through the de-identification engine (deid.cjs) on the way out and back.
// Listens on 127.0.0.1 only. A request it cannot inspect is refused, not forwarded.
// usage: node server.cjs            env: DEID_PORT (default 3003), DEID_UPSTREAM (default https://api.anthropic.com),
//                                        DEID_DIR (vault.json, dictionary.txt, audit.jsonl; default this folder)
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { createVault, createEngine } = require('./deid.cjs');
const { pdfTexts } = require('./pdftext.cjs');
const { imageMasks } = require('./imgocr.cjs');

const PORT = Number(process.env.DEID_PORT || 3003);
const UPSTREAM = new URL(process.env.DEID_UPSTREAM || 'https://api.anthropic.com');
const DIR = process.env.DEID_DIR || __dirname;
const vault = createVault(path.join(DIR, 'vault.json'));
const engine = createEngine({ vault, dictFile: path.join(DIR, 'dictionary.txt') });
// The audit log holds counts per kind, never the values.
const audit = (rec) => fs.appendFile(path.join(DIR, 'audit.jsonl'), JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n', () => {});
const refuse = (res, status, why) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'deid_proxy_refused', message: 'deid-proxy: ' + why } })); };

http.createServer((req, res) => {
  if (req.url === '/_deid/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, vault: vault.size() })); }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body = Buffer.concat(chunks);
    const rec = { path: req.url.split('?')[0], method: req.method };
    const counts = {};
    if (body.length) {
      if (!rec.path.startsWith('/v1/messages')) { audit({ ...rec, refused: 'unknown path with a body' }); return refuse(res, 403, 'this path is not inspected, so it is not forwarded: ' + rec.path); }
      try {
        const parsed = JSON.parse(body.toString('utf8'));
        rec.model = parsed.model;
        const pdf = await pdfTexts(parsed);
        const img = await imageMasks(parsed, engine.findHits);
        body = Buffer.from(JSON.stringify(engine.aliasRequest(parsed, counts, { pdf, img })));
      } catch (e) { audit({ ...rec, refused: String(e.message) }); return refuse(res, 400, 'request could not be inspected, so it was not forwarded (' + e.message + ')'); }
    }
    const headers = { ...req.headers, host: UPSTREAM.host };
    delete headers['accept-encoding'];
    if (body.length) headers['content-length'] = String(body.length); else delete headers['content-length'];
    const lib = UPSTREAM.protocol === 'http:' ? http : https;
    const up = lib.request({ host: UPSTREAM.hostname, port: UPSTREAM.port || undefined, path: req.url, method: req.method, headers }, (ur) => {
      const h = { ...ur.headers }; delete h['content-length'];
      res.writeHead(ur.statusCode, h);
      const sse = /event-stream/.test(ur.headers['content-type'] || '');
      const fix = sse ? engine.sseRestorer() : null;
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
}).listen(PORT, '127.0.0.1', () => console.log(`deid-proxy on 127.0.0.1:${PORT} -> ${UPSTREAM.origin}, vault ${vault.size()} entries`));
