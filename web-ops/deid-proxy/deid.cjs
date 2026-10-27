// De-identification engine for the DHC CLI model proxy (server.cjs).
// Outbound: sensitive values in what Claude Code sends to the model become aliases (DEID_<KIND>_<n>).
// Inbound: aliases in the model's text and tool-call arguments become the real values again, so tools run on real
// data and the user reads real text, while the model only ever sees aliases.
// The alias <-> value table (the vault) stays on this machine and is append-only, so one value always maps to one
// alias; that keeps conversations consistent and the prompt cache valid.
'use strict';
const crypto = require('crypto');
const fs = require('fs');

const ALIAS = /DEID_[A-Z]+_\d+/g;
// Tail of a stream chunk that could be the beginning of an alias; held back until the next chunk decides.
const ALIAS_HEAD = /D(E(I(D(_([A-Z]+(_(\d*)?)?)?)?)?)?)?$/;

function twIdOk(s) {
  const n = 'ABCDEFGHJKLMNPQRSTUVXYWZIO'.indexOf(s[0]) + 10;
  const digits = [Math.floor(n / 10), n % 10, ...s.slice(1)].map(Number);
  const weights = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
  return digits.reduce((sum, d, i) => sum + d * weights[i], 0) % 10 === 0;
}
// A value after "password=" counts as a secret only when it looks like one; this keeps code such as
// `password: string` or `pwd = getPassword()` from turning ordinary words into aliases.
const secretLike = (s) => s.length >= 8 && /\d/.test(s) && /[A-Za-z]/.test(s);

const SURNAME = '歐陽|司馬|張簡|范姜|諸葛|[陳林黃張李王吳劉蔡楊許鄭謝郭洪曾邱廖賴周徐蘇葉莊呂江何蕭羅高簡朱鍾施游詹沈彭胡余盧潘顏梁趙柯翁魏方孫戴范宋鄧杜傅侯溫薛丁馬蔣唐卓藍馮姚石董紀歐程連古汪湯姜田康鄒白涂凃尤巫韓龔嚴袁黎阮陸倪夏童邵柳錢]';
const TITLE = '(?:先生|小姐|女士|董事長|總經理|副總|協理|經理|副理|襄理|主任|專員|科長|處長|部長|組長|老師|同學)';
// [kind, pattern, optional check]. Patterns that identify a value by its own shape.
const DETECTORS = [
  ['SECRET', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['SECRET', /(?<=(?:password|passwd|pwd|密碼)["']?\s*[=:：]\s*["']?)[^\s;,'"&<>(){}]{8,}/gi, secretLike],
  ['ID', /(?<![A-Za-z0-9])[A-Z][12]\d{8}(?!\d)/g, twIdOk],
  ['EMP', /(?<![A-Za-z0-9])[Ee]\d{7}(?!\d)/g],
  ['EMAIL', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g],
  ['PHONE', /(?<!\d)09\d{2}-?\d{3}-?\d{3}(?!\d)/g],
  ['IP', /(?<![\d.])(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}(?![\d.]*\d)/g],
  ['PATH', /\\\\[A-Za-z0-9_.-]+\\[^\\\s"'<>|*?]+/g],
  // Person names without a roster: a surname plus up to two characters right before a title, or right after a name label.
  ['NAME', new RegExp(`(?:${SURNAME})[\\u4e00-\\u9fff]{0,2}?(?=${TITLE})`, 'g')],
  ['NAME', new RegExp(`(?<=(?:姓名|承辦人|聯絡人|經辦人?|申請人|負責人|收件人|寄件人|簽核人|交易員|業務員)\\s*[：:]?\\s*)(?:${SURNAME})[\\u4e00-\\u9fff]{1,2}`, 'g')],
  // Project codes without a roster: the code right after a project label (listed projects go in dictionary.txt as PROJ).
  ['PROJ', /(?<=(?:專案代號|專案編號|專案名稱|計畫代號|計畫編號|案號|案件編號)\s*[：:#＃]?\s*)[A-Za-z][A-Za-z0-9_-]{1,23}/g],
  ['PROJ', /(?<=(?:專案|[Pp]roject(?:\s+(?:[Cc]ode|ID|[Nn]ame))?)\s*[：:#＃]\s*)[A-Za-z][A-Za-z0-9_-]{1,23}/g],
  // Business amounts (2026-10-22): sign included so gains and losses look alike. Plain integers, dates, codes and ports stay.
  ['AMT', /(?<![\w.,])[-(]?\d{1,3}(?:,\d{3})+(?:\.\d+)?\)?(?![\d,]*\d)/g],
  ['AMT', /(?<![\w.])-?\d{4,}\.\d+(?![\d.])/g],
  ['AMT', /(?<![\w.])-?\d+(?:\.\d+)?\s*(?:元|萬元?|億元?|千元|百萬元?|仟元)/g],
  ['AMT', /(?:NT\$|US\$|\$|NTD|TWD|USD|新台幣|台幣|美元)\s*-?\d[\d,]*(?:\.\d+)?/g],
  ['AMT', /(?<=(?:損益|金額|部位|市值|成本|淨值|餘額|曝險|額度|保證金|淨資本|收入|費用|獲利|虧損|PnL|P&L|VaR)[^\n\d]{0,6})-?\d+(?:\.\d+)?/gi],
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const jsonEsc = (s) => JSON.stringify(s).slice(1, -1);

function createVault(file) {
  let data = { next: {}, map: {} };
  if (file && fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byReal = new Map(Object.entries(data.map).map(([alias, real]) => [real, alias]));
  let dirty = false;
  return {
    aliasFor(kind, real) {
      let alias = byReal.get(real);
      if (!alias) {
        data.next[kind] = (data.next[kind] || 0) + 1;
        alias = `DEID_${kind}_${data.next[kind]}`;
        data.map[alias] = real; byReal.set(real, alias); dirty = true;
      }
      return alias;
    },
    realFor: (alias) => data.map[alias],
    secrets: () => Object.entries(data.map).filter(([a]) => a.startsWith('DEID_SECRET_')).map(([, real]) => real),
    size: () => byReal.size,
    flush() {
      if (!dirty || !file) return;
      fs.writeFileSync(file + '.tmp', JSON.stringify(data));
      fs.renameSync(file + '.tmp', file);
      dirty = false;
    },
  };
}

// Dictionary file: one "KIND term" per line, # for comments. Terms have no shape of their own (names, hosts, tables).
function loadDictionary(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => /^([A-Z]+)\s+(.+)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim()]);
}
function termPattern(terms) {
  if (!terms.length) return null;
  const alt = [...terms].sort((a, b) => b.length - a.length)
    .map((t) => (/^[\x21-\x7e]+$/.test(t) ? `(?<![A-Za-z0-9_])${escapeRe(t)}(?![A-Za-z0-9_])` : escapeRe(t)));
  return new RegExp(alt.join('|'), 'gi');
}

function createEngine({ vault, dictFile }) {
  let dict = [], dictRe = null, dictKind = new Map(), dictStamp = -1;
  let secretRe = null, secretCount = -1;
  function refresh() {
    const stamp = dictFile && fs.existsSync(dictFile) ? fs.statSync(dictFile).mtimeMs : 0;
    if (stamp !== dictStamp) {
      dict = loadDictionary(dictFile); dictStamp = stamp;
      dictRe = termPattern(dict.map(([, t]) => t));
      dictKind = new Map(dict.map(([k, t]) => [t.toLowerCase(), k]));
    }
    const secrets = vault.secrets();
    if (secrets.length !== secretCount) { secretCount = secrets.length; secretRe = secrets.length ? new RegExp(secrets.sort((a, b) => b.length - a.length).map(escapeRe).join('|'), 'g') : null; }
  }

  // [start, end, kind] for every sensitive span in s, sorted, overlaps included.
  function findHits(s, withLit = true) {
    const hits = [];
    const scan = (re, kindOf, check) => { re.lastIndex = 0; for (let m; (m = re.exec(s));) { if (!m[0]) { re.lastIndex++; continue; } if (!check || check(m[0])) hits.push([m.index, m.index + m[0].length, kindOf(m[0])]); } };
    for (const [kind, re, check] of DETECTORS) scan(re, () => kind, check);
    if (dictRe) scan(dictRe, (t) => dictKind.get(t.toLowerCase()) || 'TERM');
    if (secretRe) scan(secretRe, () => 'SECRET');
    // Text that already looks like an alias is aliased too, so a restore can never mistake it for one of ours.
    if (withLit) scan(ALIAS, () => 'LIT');
    return hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  }

  function aliasText(s, counts = {}) {
    if (typeof s !== 'string' || !s) return s;
    const hits = findHits(s);
    if (!hits.length) return s;
    let out = '', at = 0;
    for (const [start, end, kind] of hits) {
      if (start < at) continue;
      out += s.slice(at, start) + vault.aliasFor(kind, s.slice(start, end));
      counts[kind] = (counts[kind] || 0) + 1; at = end;
    }
    return out + s.slice(at);
  }
  const deep = (v, counts) => (typeof v === 'string' ? aliasText(v, counts)
    : Array.isArray(v) ? v.map((x) => deep(x, counts))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x, counts)])) : v);
  // Tool schemas: only the human-readable descriptions; names and property keys must reach the model unchanged.
  const descriptions = (v, counts) => (Array.isArray(v) ? v.map((x) => descriptions(x, counts))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'description' && typeof x === 'string' ? aliasText(x, counts) : descriptions(x, counts)])) : v);

  // An attachment the proxy cannot read is held: the model gets a notice instead of the file, and the sender reviews it.
  // It goes out unchanged only after the sender types RELEASE + the attachment's 8-character code in a message of their own.
  const RELEASE = '覆核放行';
  const RELEASE_RE = new RegExp(RELEASE + '\\s*([0-9a-f]{8})', 'g');
  const codeOf = (src) => crypto.createHash('sha256').update(String(src?.data ?? src?.url ?? src?.file_id ?? JSON.stringify(src ?? null))).digest('hex').slice(0, 8);
  // send: what goes out once the sender releases it (default the attachment as it is).
  function held(b, counts, kind, what, released, send = b) {
    counts[kind] = (counts[kind] || 0) + 1;
    const code = codeOf(b.source);
    if (released.has(code)) { counts.RELEASED = (counts.RELEASED || 0) + 1; return send; }
    counts.HELD = (counts.HELD || 0) + 1;
    const text = `[去識別層擋下附件：${what}。${kind === 'FACE' ? '人臉無法去識別' : '本機讀不出內容，無法檢查機密'}，所以沒有送給模型。`
      + `請轉告發送者覆核：改成可讀的文字、有文字層的 PDF 或 PNG／JPG 後重傳；若確認內容可以送出，由發送者親自輸入「${RELEASE} ${code}」。]`;
    return { type: 'text', text, ...(b.cache_control ? { cache_control: b.cache_control } : {}) };
  }
  // Release codes count only in text the user typed (user-role text blocks or string content), never in tool results.
  function releasedCodes(messages) {
    const out = new Set();
    for (const m of messages) {
      if (m.role !== 'user') continue;
      const texts = typeof m.content === 'string' ? [m.content] : Array.isArray(m.content) ? m.content.filter((b) => b?.type === 'text').map((b) => b.text) : [];
      for (const t of texts) for (const x of String(t).matchAll(RELEASE_RE)) out.add(x[1]);
    }
    return out;
  }

  // A PDF whose text layer the proxy read (pdftext.cjs) goes out as de-identified text instead of the file.
  // Scans and unreadable PDFs are held.
  function pdfBlock(b, counts, att) {
    const r = att.pdf && att.pdf.get(b.source.data);
    if (!r || r.kind !== 'text') {
      const k = !r ? 'PDF_UNREAD' : r.kind === 'scan' ? 'PDF_SCAN' : 'PDF_ERROR';
      const name = b.title ? `「${b.title}」` : '';
      return held(b, counts, k, k === 'PDF_SCAN' ? `掃描版 PDF${name}（沒有文字層）` : `PDF${name}（讀取失敗）`, att.released);
    }
    counts.PDF_TEXT = (counts.PDF_TEXT || 0) + 1;
    const { type, source, title, context, citations, ...rest } = b;
    const head = `[PDF 附件${title ? '「' + title + '」' : ''}，共 ${r.pages} 頁。代理已在本機抽出文字層並去識別，原檔的版面、表格框線與圖片沒有送出。]`
      + (context ? '\n' + context : '');
    return { ...rest, type: 'text', text: aliasText(head + '\n\n' + r.text, counts) };
  }

  // An image the proxy read with OCR (imgocr.cjs) goes out with the words of every hit painted black.
  // Images it could not read (format, timeout, not base64) are held.
  function imageBlock(b, counts, att) {
    const r = att.img && b.source?.type === 'base64' && att.img.get(b.source.data);
    if (!r || r.kind === 'error') {
      const fmt = b.source?.type === 'base64' ? String(b.source.media_type || '').replace('image/', '') : '連結';
      return held(b, counts, 'IMAGE', `圖片（${fmt || '未知格式'}${r?.why === 'timeout' ? '，辨識逾時' : ''}）`, att.released);
    }
    const out = r.kind === 'clean' ? b : { ...b, source: { ...b.source, media_type: r.media_type, data: r.data } };
    if (r.kind === 'masked') for (const [k, n] of Object.entries(r.kinds)) counts[k] = (counts[k] || 0) + n;
    // Faces: held for the sender's review; a release sends the text-masked version.
    if (r.faces > 0) return held(b, counts, 'FACE', `圖片含人臉（${r.faces} 張）`, att.released, out);
    const k = r.kind === 'clean' ? 'IMG_CLEAN' : 'IMG_MASKED';
    counts[k] = (counts[k] || 0) + 1;
    return out;
  }

  function block(b, counts, att) {
    if (!b || typeof b !== 'object') return b;
    if (b.type === 'document' && b.source?.type === 'base64' && b.source.media_type === 'application/pdf') return pdfBlock(b, counts, att);
    if (b.type === 'image') return imageBlock(b, counts, att);
    if (b.type === 'text') return { ...b, text: aliasText(b.text, counts) };
    if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') return { ...b, input: deep(b.input, counts) };
    if (b.type === 'tool_result' || b.type === 'mcp_tool_result') return { ...b, content: content(b.content, counts, att) };
    // Signed thinking must go back byte-identical; it only ever held aliases.
    if (b.type === 'thinking' || b.type === 'redacted_thinking') return b;
    counts.UNSCANNED = (counts.UNSCANNED || 0) + 1;
    return b;
  }
  const content = (c, counts, att) => (typeof c === 'string' ? aliasText(c, counts) : Array.isArray(c) ? c.map((b) => block(b, counts, att)) : c);

  const NOTE = 'Some values in this conversation appear as stand-in tokens of the form DEID_<KIND>_<number> (for example an IP address, a person, a path). '
    + 'Each token stands for one real value and is swapped back automatically before tools run and before the user reads your reply. '
    + 'Use each token verbatim wherever you would use the real value, and do not comment on the tokens or describe them as placeholders. '
    + 'When an attachment shows up as a notice starting with [去識別層擋下附件, tell the user which one was held and pass on the notice, release phrase included; '
    + 'do not try to get its content another way (reading the file, converting it, printing its bytes).';

  // Returns the request body to send upstream. Throws when the body is not a messages request it understands.
  // att.pdf: Map from a PDF's base64 data to its pdftext.cjs result; att.img: from an image's to its imgocr.cjs result.
  function aliasRequest(body, counts = {}, att = {}) {
    refresh();
    if (!body || !Array.isArray(body.messages)) throw new Error('not a messages request');
    att = { ...att, released: releasedCodes(body.messages) };
    const out = { ...body };
    out.messages = body.messages.map((m) => ({ ...m, content: content(m.content, counts, att) }));
    if (typeof body.system === 'string') out.system = aliasText(body.system, counts) + '\n\n' + NOTE;
    else if (Array.isArray(body.system)) out.system = [...body.system.map((b) => block(b, counts, att)), { type: 'text', text: NOTE }];
    else out.system = NOTE;
    if (Array.isArray(body.tools)) out.tools = body.tools.map((t) => descriptions(t, counts));
    vault.flush();
    return out;
  }

  const restoreText = (s, inJson) => s.replace(ALIAS, (a) => { const real = vault.realFor(a); return real === undefined ? a : inJson ? jsonEsc(real) : real; });

  // Rewrites a text/event-stream response. An alias may arrive split across deltas, so each content block keeps a tail.
  function sseRestorer() {
    const tail = new Map();
    let buf = '';
    const piece = (idx, text, inJson, last) => {
      let s = (tail.get(idx)?.text || '') + text, held = '';
      if (!last) { const m = ALIAS_HEAD.exec(s); if (m && m[0]) { held = m[0]; s = s.slice(0, -held.length); } }
      tail.set(idx, { text: held, inJson });
      return restoreText(s, inJson);
    };
    const event = (raw) => {
      const m = /^data: (.*)$/m.exec(raw);
      if (!m) return raw;
      let d; try { d = JSON.parse(m[1]); } catch { return raw; }
      if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta') d.delta.text = piece(d.index, d.delta.text, false);
      else if (d.type === 'content_block_delta' && d.delta?.type === 'input_json_delta') d.delta.partial_json = piece(d.index, d.delta.partial_json, true);
      else if (d.type === 'content_block_stop' && tail.get(d.index)?.text) {
        const { inJson } = tail.get(d.index);
        const rest = piece(d.index, '', inJson, true);
        const delta = inJson ? { type: 'input_json_delta', partial_json: rest } : { type: 'text_delta', text: rest };
        return `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: d.index, delta })}\n\n${raw}`;
      } else return raw;
      return raw.replace(m[0], () => 'data: ' + JSON.stringify(d));
    };
    return (chunk, end) => {
      buf += chunk; let out = '', i;
      while ((i = buf.indexOf('\n\n')) >= 0) { out += event(buf.slice(0, i)) + '\n\n'; buf = buf.slice(i + 2); }
      if (end && buf) { out += event(buf); buf = ''; }
      return out;
    };
  }

  return { aliasText: (s, counts) => { refresh(); return aliasText(s, counts); }, findHits: (s) => { refresh(); return findHits(s, false); }, aliasRequest, restoreText, sseRestorer };
}

module.exports = { createVault, createEngine, twIdOk };
