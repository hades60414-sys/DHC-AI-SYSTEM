import JSZip from 'jszip';

/**
 * DHC CLI 個資防誤傳 (2026-11-02): nothing that carries a Taiwan national ID, resident certificate number, card
 * number or mobile number may leave the browser. The composer checks a turn before it sends (so the draft stays in
 * the box), and installPiiNetworkGuard checks every fetch / XHR / WebSocket body as the backstop for every other
 * path — draft sync, file-tree and canvas uploads, the shell. The goal is to stop accidental sends, not to hide
 * anything from the company network.
 */

export type PiiKind = '身分證字號' | '居留證號' | '信用卡號' | '手機號碼';
export type PiiHit = { kind: PiiKind; masked: string; source?: string };

export const PII_BLOCK_EVENT = 'dhc:pii-blocked';

const LETTER_CODES: Record<string, number> = {
  A: 10, B: 11, C: 12, D: 13, E: 14, F: 15, G: 16, H: 17, I: 34, J: 18, K: 19, L: 20, M: 21,
  N: 22, O: 35, P: 23, Q: 24, R: 25, S: 26, T: 27, U: 28, V: 29, W: 32, X: 30, Y: 31, Z: 33,
};

// National ID (2nd char 1/2), new resident certificate (8/9) and old resident certificate (A-D) share one
// checksum; the old form counts the second letter's last digit.
function validTaiwanId(id: string): boolean {
  const first = LETTER_CODES[id[0]];
  const second = /\d/.test(id[1]) ? Number(id[1]) : (LETTER_CODES[id[1]] ?? NaN) % 10;
  if (first === undefined || Number.isNaN(second)) return false;
  const digits = [second, ...id.slice(2).split('').map(Number)];
  const weights = [8, 7, 6, 5, 4, 3, 2, 1, 1];
  const sum = Math.floor(first / 10) + (first % 10) * 9 + digits.reduce((acc, d, i) => acc + d * weights[i], 0);
  return sum % 10 === 0;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function cardBrandLength(digits: string): boolean {
  if (/^4/.test(digits)) return digits.length === 13 || digits.length === 16 || digits.length === 19;
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(digits)) return digits.length === 16;
  if (/^3[47]/.test(digits)) return digits.length === 15;
  if (/^35/.test(digits)) return digits.length === 16;
  if (/^62/.test(digits)) return digits.length >= 16 && digits.length <= 19;
  return false;
}

const mask = (value: string) => value.length <= 6 ? '*'.repeat(value.length) : `${value.slice(0, 3)}${'*'.repeat(value.length - 6)}${value.slice(-3)}`;

const ID_RE = /(?<![A-Za-z0-9])([A-Za-z])([1289A-Da-d])(\d{8})(?![0-9])/g;
// A number glued to letters is part of a hash or code, not a phone or card.
const CARD_RE = /(?<![0-9A-Za-z])(\d(?:[ -]?\d){12,18})(?![0-9A-Za-z])/g;
const MOBILE_RE = /(?<![0-9A-Za-z+])(?:\+?886[ -]?|0)9\d{2}[ -]?\d{3}[ -]?\d{3}(?![0-9A-Za-z])/g;

/** Finds personal data in a piece of text; each distinct value is reported once. */
export function findPii(text: string): PiiHit[] {
  if (!text) return [];
  const hits = new Map<string, PiiHit>();
  for (const m of text.matchAll(ID_RE)) {
    const id = m[0].toUpperCase();
    if (!validTaiwanId(id)) continue;
    hits.set(id, { kind: /^[A-Z][12]/.test(id) ? '身分證字號' : '居留證號', masked: mask(id) });
  }
  for (const m of text.matchAll(CARD_RE)) {
    const digits = m[1].replace(/[ -]/g, '');
    if (cardBrandLength(digits) && luhn(digits)) hits.set(digits, { kind: '信用卡號', masked: mask(digits) });
  }
  for (const m of text.matchAll(MOBILE_RE)) {
    const digits = m[0].replace(/[ -]/g, '').replace(/^\+?886/, '0');
    hits.set(digits, { kind: '手機號碼', masked: mask(digits) });
  }
  return [...hits.values()];
}

const OOXML_RE = /\.(xlsx|xlsm|docx|docm|pptx|pptm)$/i;

// Every pattern is ASCII, so any file can be read as Latin-1 (and as UTF-16 with the zero bytes dropped, for old
// .xls/.doc and "Unicode text" exports) without caring about its real encoding. Office Open XML is a zip, so it is
// opened and its XML parts are read. Compressed PDF streams and images cannot be read this way.
const readBytes = (blob: Blob) => new Promise<Uint8Array>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
  reader.onerror = () => reject(reader.error);
  reader.readAsArrayBuffer(blob);
});

async function fileText(file: Blob & { name?: string }): Promise<string> {
  const bytes = await readBytes(file);
  if (file.name && OOXML_RE.test(file.name)) {
    try {
      const zip = await JSZip.loadAsync(bytes);
      const parts = Object.values(zip.files).filter((f) => !f.dir && /\.xml$/i.test(f.name));
      return (await Promise.all(parts.map((f) => f.async('string')))).join('\n');
    } catch {
      // Not a readable zip: fall through to the raw read.
    }
  }
  const latin1 = new TextDecoder('latin1').decode(bytes);
  return `${latin1}\n${latin1.replace(/\0/g, '')}`;
}

export async function findPiiInFile(file: Blob & { name?: string }): Promise<PiiHit[]> {
  return findPii(await fileText(file)).map((hit) => ({ ...hit, source: file.name }));
}

/** Text plus attachments of one composer turn. */
export async function findPiiInTurn(text: string, files: File[]): Promise<PiiHit[]> {
  const fileHits = await Promise.all(files.map(findPiiInFile));
  return [...findPii(text), ...fileHits.flat()];
}

export function piiBlockMessage(hits: PiiHit[]): string {
  const lines = hits.slice(0, 5).map((h) => `・${h.kind} ${h.masked}${h.source ? `（${h.source}）` : ''}`);
  if (hits.length > 5) lines.push(`・另有 ${hits.length - 5} 筆`);
  return `偵測到個資，這次沒有送出：\n${lines.join('\n')}\n請刪掉或改成代號後再送。`;
}

function urlText(url: string | undefined): string {
  if (!url) return '';
  try { return decodeURIComponent(url); } catch { return url; }
}

async function bodyText(body: unknown): Promise<string> {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return urlText(body.toString());
  if (body instanceof Blob) return fileText(body as Blob & { name?: string });
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return fileText(new Blob([body as BlobPart]));
  if (body instanceof FormData) {
    const parts = await Promise.all([...body.entries()].map(([, v]) => (typeof v === 'string' ? v : fileText(v))));
    return parts.join('\n');
  }
  return '';
}

export async function findPiiInRequest(url: string | undefined, body: unknown): Promise<PiiHit[]> {
  return findPii(`${urlText(url)}\n${await bodyText(body)}`);
}

export class PiiBlockedError extends Error {
  hits: PiiHit[];
  constructor(hits: PiiHit[]) { super(piiBlockMessage(hits)); this.name = 'PiiBlockedError'; this.hits = hits; }
}

function announce(hits: PiiHit[]): void {
  window.dispatchEvent(new CustomEvent(PII_BLOCK_EVENT, { detail: { message: piiBlockMessage(hits) } }));
}

let installed = false;

export function installPiiNetworkGuard(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = init?.body ?? (input instanceof Request && input.body ? await input.clone().blob() : null);
    const hits = await findPiiInRequest(url, body);
    if (hits.length > 0) { announce(hits); throw new PiiBlockedError(hits); }
    return originalFetch(input, init);
  };

  const urls = new WeakMap<XMLHttpRequest, string>();
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function open(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    urls.set(this, String(url));
    return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = function send(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    void findPiiInRequest(urls.get(this), body).then((hits) => {
      if (hits.length === 0) { originalSend.call(this, body); return; }
      announce(hits);
      // Never sent, so no real event will come: fail it the way a network error would.
      this.dispatchEvent(new ProgressEvent('error'));
      this.dispatchEvent(new ProgressEvent('loadend'));
    });
  };

  const originalWsSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function send(this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (typeof data === 'string') {
      const hits = findPii(data);
      if (hits.length > 0) { announce(hits); return; }
    }
    originalWsSend.call(this, data);
  };
}
