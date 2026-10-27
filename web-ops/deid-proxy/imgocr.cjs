// Images for the de-identification proxy. Each base64 image is read with the Windows built-in OCR (imgocr.ps1,
// Chinese and English engines), the engine's detectors run over the recognised lines, and every word that is part
// of a hit is painted black before the image goes upstream. An image is sent again with every later request of the
// same chat, so OCR results and masked images are cached by SHA-256 and each image is read once per proxy run.
// An image that cannot be read (format, timeout, OCR error) goes out unchanged and is counted, like scanned PDFs.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const TIMEOUT_MS = 20000;
const CACHE_MAX = 300;
const PAD = 2;
const PS1 = path.join(__dirname, 'imgocr.ps1');
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif' };
const ocrCache = new Map();  // sha256 -> { w, h, engines } | { error }
const maskCache = new Map(); // sha256 + boxes -> { data, media_type }

const remember = (m, key, v) => { m.delete(key); m.set(key, v); if (m.size > CACHE_MAX) m.delete(m.keys().next().value); return v; };
const ps = (args) => new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...args],
  { timeout: TIMEOUT_MS, windowsHide: true }, (e, _o, err) => (e ? reject(new Error(e.killed ? 'timeout' : String(err || e.message).trim().slice(0, 200))) : resolve())));

async function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deid-img-'));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function ocr(data, mediaType, key) {
  const hit = ocrCache.get(key);
  if (hit) return remember(ocrCache, key, hit);
  if (!EXT[mediaType]) return remember(ocrCache, key, { error: 'format ' + mediaType });
  try {
    return remember(ocrCache, key, await withTemp(async (dir) => {
      const img = path.join(dir, 'in' + EXT[mediaType]), out = path.join(dir, 'ocr.json');
      fs.writeFileSync(img, Buffer.from(data, 'base64'));
      await ps(['ocr', img, out]);
      return JSON.parse(fs.readFileSync(out, 'utf8').replace(/^﻿/, ''));
    }));
  } catch (e) { return e.message === 'timeout' ? { error: 'timeout' } : remember(ocrCache, key, { error: e.message }); } // timeouts retry next request
}

const cjk = (ch) => /[⺀-鿿豈-﫿＀-￯　-〿]/.test(ch || '');
// One OCR line as text plus each word's offset. The Chinese engine returns one character per word, so words are
// joined without a space when either side is CJK; that lets dictionary terms and "密碼=" patterns match.
function lineText(words) {
  let s = '';
  const spans = words.map((w, i) => {
    if (i && !cjk(s.slice(-1)) && !cjk(w.t[0])) s += ' ';
    const start = s.length; s += w.t;
    return [start, s.length, w.b];
  });
  return { s, spans };
}

// Rectangles [x, y, w, h] covering every word that overlaps a hit, and the hit kinds found.
function boxesFor(o, findHits) {
  const boxes = [], kinds = {};
  for (const e of o.engines || []) for (const words of e.lines || []) {
    const { s, spans } = lineText(words.filter((w) => w && typeof w.t === 'string'));
    for (const [hs, he, kind] of findHits(s)) {
      const covered = spans.filter(([ws, we]) => ws < he && we > hs).map(([, , b]) => b);
      if (!covered.length) continue;
      const x0 = Math.min(...covered.map((b) => b[0])), y0 = Math.min(...covered.map((b) => b[1]));
      const x1 = Math.max(...covered.map((b) => b[0] + b[2])), y1 = Math.max(...covered.map((b) => b[1] + b[3]));
      const x = Math.max(0, x0 - PAD), y = Math.max(0, y0 - PAD);
      boxes.push([x, y, Math.min(o.w, x1 + PAD) - x, Math.min(o.h, y1 + PAD) - y]);
      kinds[kind] = (kinds[kind] || 0) + 1;
    }
  }
  return { boxes, kinds };
}

async function mask(data, mediaType, boxes, key) {
  const mkey = key + JSON.stringify(boxes);
  const hit = maskCache.get(mkey);
  if (hit) return remember(maskCache, mkey, hit);
  const outType = mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  return remember(maskCache, mkey, await withTemp(async (dir) => {
    const img = path.join(dir, 'in' + EXT[mediaType]), bx = path.join(dir, 'boxes.json'), out = path.join(dir, 'out' + EXT[outType]);
    fs.writeFileSync(img, Buffer.from(data, 'base64'));
    fs.writeFileSync(bx, JSON.stringify(boxes));
    await ps(['mask', img, bx, out]);
    return { data: fs.readFileSync(out).toString('base64'), media_type: outType };
  }));
}

// Resolves to { kind: 'clean' | 'masked' | 'error', why?, data?, media_type?, kinds?, faces }.
// faces > 0 means the deid engine holds the image for review; data is still the text-masked version for a release.
async function imageMask(data, mediaType, findHits) {
  const key = crypto.createHash('sha256').update(data).digest('hex');
  const o = await ocr(data, mediaType, key);
  if (o.error) return { kind: 'error', why: o.error };
  const faces = o.faces || 0;
  const { boxes, kinds } = boxesFor(o, findHits);
  if (!boxes.length) return { kind: 'clean', faces };
  try { return { kind: 'masked', kinds, faces, boxes: boxes.length, ...(await mask(data, mediaType, boxes, key)) }; }
  catch (e) { return { kind: 'error', why: 'mask: ' + e.message }; }
}

// Every base64 image in a messages request (user content, tool results, system), as [data, media_type].
function imageBlocks(body) {
  const found = new Map();
  const walk = (c) => {
    if (!Array.isArray(c)) return;
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'image' && b.source?.type === 'base64' && typeof b.source.data === 'string') found.set(b.source.data, b.source.media_type);
      if (b.type === 'tool_result' || b.type === 'mcp_tool_result') walk(b.content);
    }
  };
  for (const m of body.messages || []) walk(m.content);
  walk(body.system);
  return [...found];
}

// Map for engine.aliasRequest's { img } option: base64 string -> result.
async function imageMasks(body, findHits) {
  const out = new Map();
  for (const [data, type] of imageBlocks(body)) out.set(data, await imageMask(data, type, findHits));
  return out;
}

module.exports = { imageMask, imageMasks, imageBlocks, lineText };
