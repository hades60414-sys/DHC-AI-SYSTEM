// pii-mask.cjs — 個資遮罩 (2026-11-02, 使用者：一律遮罩，不依 IP 區分). seal-proxy runs everything it sends to a
// browser through here, so a Taiwan ID / resident number / card number / mobile number never leaves srv-main in the
// clear. Masks keep the length and only swap ASCII for '*', so a WebSocket frame or a Content-Length stays valid.
// The same rules as the browser guard (claudecodeui src/shared/piiGuard.ts). No dependencies.
'use strict';
const zlib = require('zlib');

const LETTER_CODES = { A: 10, B: 11, C: 12, D: 13, E: 14, F: 15, G: 16, H: 17, I: 34, J: 18, K: 19, L: 20, M: 21,
  N: 22, O: 35, P: 23, Q: 24, R: 25, S: 26, T: 27, U: 28, V: 29, W: 32, X: 30, Y: 31, Z: 33 };

function validTaiwanId(id) {
  const first = LETTER_CODES[id[0]];
  const second = /\d/.test(id[1]) ? Number(id[1]) : (LETTER_CODES[id[1]] ?? NaN) % 10;
  if (first === undefined || Number.isNaN(second)) return false;
  const digits = [second, ...id.slice(2).split('').map(Number)];
  const weights = [8, 7, 6, 5, 4, 3, 2, 1, 1];
  const sum = Math.floor(first / 10) + (first % 10) * 9 + digits.reduce((acc, d, i) => acc + d * weights[i], 0);
  return sum % 10 === 0;
}

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function cardBrandLength(digits) {
  if (/^4/.test(digits)) return digits.length === 13 || digits.length === 16 || digits.length === 19;
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(digits)) return digits.length === 16;
  if (/^3[47]/.test(digits)) return digits.length === 15;
  if (/^35/.test(digits)) return digits.length === 16;
  if (/^62/.test(digits)) return digits.length >= 16 && digits.length <= 19;
  return false;
}

const ID_RE = /(?<![A-Za-z0-9])[A-Za-z][1289A-Da-d]\d{8}(?![0-9])/g;
const CARD_RE = /(?<![0-9A-Za-z])\d(?:[ -]?\d){12,18}(?![0-9A-Za-z])/g;
const MOBILE_RE = /(?<![0-9A-Za-z+])(?:\+?886[ -]?|0)9\d{2}[ -]?\d{3}[ -]?\d{3}(?![0-9A-Za-z])/g;
// What a masked value looks like once it has been shown: kept head, stars, kept tail.
const MASKED_RE = /(?<![0-9A-Za-z])[0-9A-Za-z+]{3}\*{4,}[0-9A-Za-z]{3}(?![0-9A-Za-z])/;

const maskValue = (v) => v.slice(0, 3) + '*'.repeat(v.length - 6) + v.slice(-3);

/** Returns { text, count } with every hit replaced by a same-length mask. */
function maskText(text) {
  let count = 0;
  const swap = (valid) => (m) => { if (!valid(m)) return m; count += 1; return maskValue(m); };
  const out = text
    .replace(ID_RE, swap((m) => validTaiwanId(m.toUpperCase())))
    .replace(CARD_RE, swap((m) => { const d = m.replace(/[ -]/g, ''); return cardBrandLength(d) && luhn(d); }))
    .replace(MOBILE_RE, swap(() => true));
  return { text: out, count };
}

// A card number sent as a bare JSON number would turn into invalid JSON once starred, so it becomes a string.
const BARE_MASKED_RE = /([:[,]\s*)([0-9A-Za-z+]{3}\*{4,}[0-9A-Za-z]{3})(?=\s*[,}\]])/g;
function maskJsonish(text) {
  const masked = maskText(text);
  if (!masked.count || !/^\s*[[{]/.test(text)) return masked;
  try { JSON.parse(masked.text); return masked; } catch {}
  return { text: masked.text.replace(BARE_MASKED_RE, '$1"$2"'), count: masked.count };
}

const hasPii = (text) => maskText(text).count > 0;
const hasMaskedPii = (text) => MASKED_RE.test(text);

// A zip (xlsx/docx/pptx/zip) is read entry by entry from its local headers; stored and deflated entries only.
function zipTexts(buf) {
  const out = [];
  let i = 0;
  while (i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const start = i + 30 + nameLen + extraLen;
    if (buf.readUInt16LE(i + 6) & 0x08 || start + size > buf.length) break; // sizes in a trailing descriptor: give up
    const data = buf.subarray(start, start + size);
    try { out.push((method === 8 ? zlib.inflateRawSync(data) : data).toString('latin1')); } catch {}
    i = start + size;
  }
  return out;
}

// PDF text sits in Flate streams; text in standard fonts comes out readable, CID-font text does not.
function pdfTexts(buf) {
  const out = [];
  const s = buf.toString('latin1');
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const end = s.indexOf('endstream', re.lastIndex);
    if (end < 0) break;
    try { out.push(zlib.inflateSync(buf.subarray(re.lastIndex, end)).toString('latin1')); } catch {}
    re.lastIndex = end;
  }
  return out;
}

/** Every pattern is ASCII, so a binary body is read as Latin-1, as UTF-16 without zero bytes, and inside zip / PDF streams. */
function binaryHasPii(buf) {
  const raw = buf.toString('latin1');
  const parts = [raw, raw.replace(/\0/g, ''), ...zipTexts(buf), ...pdfTexts(buf)];
  return parts.some((p) => hasPii(p) || hasPii(p.replace(/\0/g, '')));
}

function buildFrame(firstByte, payload) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([firstByte, n])
    : n < 65536 ? Buffer.from([firstByte, 126, n >> 8, n & 0xff])
      : Buffer.concat([Buffer.from([firstByte, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([head, payload]);
}

/**
 * Server-to-browser side of a WebSocket: passes the 101 head through, then rewrites the payload of every text frame
 * (and its continuations) in place. Frames from a server are unmasked; per-message deflate is kept off by the proxy
 * dropping Sec-WebSocket-Extensions, so payloads are plain. A value split across two frames is not caught.
 */
function createWsMasker() {
  let headDone = false, inText = false, buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    const out = [];
    if (!headDone) {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return out;
      out.push(buf.subarray(0, end + 4));
      buf = buf.subarray(end + 4);
      headDone = true;
    }
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80, opcode = buf[0] & 0x0f, hasKey = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (hasKey) off += 4;
      if (buf.length < off + len) break;
      let frame = Buffer.from(buf.subarray(0, off + len));
      const text = opcode === 1 || (opcode === 0 && inText);
      if (opcode === 1) inText = !fin;
      else if (opcode === 0 && fin) inText = false;
      if (text && !hasKey) {
        const masked = maskJsonish(frame.toString('latin1', off));
        if (masked.count) frame = buildFrame(frame[0], Buffer.from(masked.text, 'latin1'));
      }
      out.push(frame);
      buf = buf.subarray(off + len);
    }
    return out;
  };
}

module.exports = { maskText, maskJsonish, hasPii, hasMaskedPii, binaryHasPii, createWsMasker };
