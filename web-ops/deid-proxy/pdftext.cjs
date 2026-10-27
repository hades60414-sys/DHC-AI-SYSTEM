// PDF text layer for the de-identification proxy. A PDF attachment is sent again with every later request of the
// same chat, so results are cached by SHA-256 of the file and each file is read once per proxy run.
// Extraction runs in one worker thread (pdftext-worker.mjs); a file that takes longer than TIMEOUT_MS gets
// { kind: 'error' } and the worker is replaced.
'use strict';
const crypto = require('crypto');
const path = require('path');
const { Worker } = require('worker_threads');

const TIMEOUT_MS = 30000;
const CACHE_MAX = 200;
const cache = new Map(); // sha256 -> { kind, pages, text } ; Map order doubles as LRU order
let worker = null, seq = 0;
const waiting = new Map(); // id -> resolve

function startWorker() {
  worker = new Worker(path.join(__dirname, 'pdftext-worker.mjs'));
  worker.on('message', (m) => { const done = waiting.get(m.id); if (done) { waiting.delete(m.id); done(m); } });
  worker.on('error', (e) => fail('worker error: ' + e.message));
  worker.on('exit', () => { worker = null; fail('worker exited'); });
  worker.unref();
}
function fail(why) { for (const [id, done] of waiting) { waiting.delete(id); done({ kind: 'error', why }); } }

function run(data) {
  if (!worker) startWorker();
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { if (waiting.delete(id)) { resolve({ kind: 'error', why: 'timeout' }); worker?.terminate(); } }, TIMEOUT_MS);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    worker.postMessage({ id, data });
  });
}

const remember = (key, r) => { cache.delete(key); cache.set(key, r); if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); return r; };

// Resolves to { kind: 'text' | 'scan' | 'error', pages?, text?, why?, cached }.
async function pdfText(data) {
  const key = crypto.createHash('sha256').update(data).digest('hex');
  const hit = cache.get(key);
  if (hit) { remember(key, hit); return { ...hit, cached: true }; }
  const { id, ...r } = await run(data);
  // Timeouts are not cached so a later request can try again.
  if (r.kind !== 'error' || r.why !== 'timeout') remember(key, r);
  return { ...r, cached: false };
}

// Every base64 PDF in a messages request (user content, tool results, system), keyed by its base64 string.
function pdfBlocks(body) {
  const found = [];
  const walk = (c) => {
    if (!Array.isArray(c)) return;
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'document' && b.source?.type === 'base64' && b.source.media_type === 'application/pdf' && typeof b.source.data === 'string') found.push(b.source.data);
      if (b.type === 'tool_result' || b.type === 'mcp_tool_result') walk(b.content);
    }
  };
  for (const m of body.messages || []) walk(m.content);
  walk(body.system);
  return [...new Set(found)];
}

// Map for engine.aliasRequest's { pdf } option: base64 string -> result.
async function pdfTexts(body) {
  const out = new Map();
  for (const data of pdfBlocks(body)) out.set(data, await pdfText(data));
  return out;
}

const stop = () => worker?.terminate();
module.exports = { pdfText, pdfTexts, pdfBlocks, stop };
