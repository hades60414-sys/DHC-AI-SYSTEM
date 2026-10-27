'use strict';
// 逐字核對（2026-09-30）：答案裡的日期、時間、帶單位的數字、代碼／表名／檔名／路徑、條號，要在引用的段落（加上問題、查詢日期、對話紀錄）裡找得到。
// 只看寫法有沒有出處，不判斷意思對不對；不呼叫模型。
//   red：所有檢索到的段落與問題都找不到（可能是算出來、推出來或編出來的）
//   yellow：引用的段落沒有，但其他檢索段落有（出處可能引錯）
const norm = s => String(s ?? '').normalize('NFKC');
const pad = n => String(n).padStart(2, '0');
const ZH = { '零': 0, '〇': 0, '一': 1, '二': 2, '兩': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
const ZH_OF = n => Object.keys(ZH).filter(k => ZH[k] === n);
const DIG = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const zhNum = n => n >= 1 && n <= 10 ? (n === 10 ? '十' : DIG[n]) : n < 20 ? '十' + DIG[n - 10] : n < 100 ? DIG[Math.floor(n / 10)] + '十' + DIG[n % 10] : '';
const UNITS = ['個營業日', '營業日', '個月', '小時', '分鐘', '工作天', '日曆日', '天', '日', '年', '月', '週', '周', '%', '萬元', '億元', '萬', '億', '元', '筆', '次', '倍', '張', '檔', '人', '家', '檔股票', '頁', '條', '點', 'bp', 'bps'];
const UNIT_RE = UNITS.slice().sort((a, b) => b.length - a.length).map(u => u.replace(/[%]/g, '\\$&')).join('|');

// 答案裡要核對的片段：去掉引用括號與 STATUS 行，免得段落編號被當成代碼
function claimText(answer) { // 引用常被包在反引號裡（`[X#01]`），連反引號一起拿掉，免得其他反引號配錯對
  return norm(answer).replace(/`?\[[^\[\]]*#\d+(?:-\d+)?\]`?/g, ' ').replace(/`?\[(?:doc_id|chunk_id|MAP:[^\]]*)\]`?/gi, ' ').replace(/^\s*STATUS:.*$/gim, ' ');
}
// 提示詞與輸出格式本身的欄位名，模型照抄不算
const STOP = new Set(['as_of_date', 'user_context', 'doc_id', 'chunk_id', 'status', 'answer', 'no_info', 'conflict', 'denied']);

// 民國日期（115年3月23日、115/03/23）換成西元再比，原文和答案寫法不同也對得上
const ROC_YMD = /(?<!\d)(\d{2,3})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, ROC_SLASH = /(?<![\d\/])(1\d{2})\/(\d{1,2})\/(\d{1,2})(?![\d\/])/g;
function dates(t) {
  const out = new Set();
  for (const m of t.matchAll(/(\d{4})\s*[-\/.年]\s*(\d{1,2})\s*[-\/.月]\s*(\d{1,2})\s*日?/g)) out.add(`${m[1]}-${pad(m[2])}-${pad(m[3])}`);
  for (const re of [ROC_YMD, ROC_SLASH]) for (const m of t.matchAll(re)) if (+m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) out.add(`${+m[1] + 1911}-${pad(m[2])}-${pad(m[3])}`);
  return out;
}
function monthDays(t) { // 沒寫年份的「3 月 23 日」
  const out = new Set();
  for (const m of t.matchAll(/(?<!\d[\s\-\/.年]*)(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) out.add(`${pad(m[1])}-${pad(m[2])}`);
  return out;
}
// 12 小時制（2026-09-30 晚上）：前面有「下午／晚上／傍晚」的 1–11 點換成 24 小時制；「3 點半」＝3:30。
// 原文（both=true）兩種寫法都收，答案只收換算後的寫法，這樣「下午 3:30」和原文「15:30」或「下午 3:30」都對得上。
const PM = /(下午|晚上|傍晚)\s*$/;
function times(t, both = false) {
  const out = new Set();
  const add = (h, mm, at) => {
    const H = Number(h), pm = H >= 1 && H <= 11 && PM.test(t.slice(Math.max(0, at - 4), at));
    if (pm) out.add(`${pad(H + 12)}:${mm}`);
    if (!pm || both) out.add(`${pad(h)}:${mm}`);
  };
  for (const m of t.matchAll(/(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])/g)) add(m[1], m[2], m.index);
  for (const m of t.matchAll(/(?<!第\s*)(?<!\d)(\d{1,2})\s*點(\s*半)?(?!\s*\d)/g)) add(m[1], m[2] ? '30' : '00', m.index);   // 「第 4 點」是條號不是時間
  if (/中午/.test(t)) out.add('12:00');
  return out;
}
// 帶單位的數字（金額、期間、比例…）；「萬」「億」換算成數值也一併記
function quantities(t) {
  const out = [];
  const re = new RegExp(`(?<![\\w.\\-])(\\d[\\d,]*(?:\\.\\d+)?)\\s*(${UNIT_RE})`, 'g');
  for (const m of t.matchAll(re)) out.push({ raw: m[0].replace(/\s+/g, ''), num: Number(m[1].replace(/,/g, '')), unit: m[2] });
  return out;
}
const scaled = q => q.unit.startsWith('萬') ? q.num * 1e4 : q.unit.startsWith('億') ? q.num * 1e8 : q.num;
// 代碼、表名、檔名、路徑：含底線、點、反斜線，或英文與數字混合（dbo.tmp_x、pa_declare.php、ACCT-ERR-9001、PT01、D:\DHC\out）
function identifiers(t) {
  const out = new Set();
  // 反引號裡只收像程式名稱的短字串（不含換行與中文標點）
  for (const m of t.matchAll(/`([^`\n]{2,80})`/g)) if (!/[，。、；：「」（）！？]/.test(m[1])) out.add(m[1].trim());
  // 路徑：全形標點正規化後變半形（，→, ：→: （→(），也要當成結尾；尾端緊接的中文字不算路徑
  for (const m of t.matchAll(/[A-Za-z]:\\[^\s，。、；;）)」』*`,:!?(]+|\\\\[^\s，。、；;）)」』*`,:!?(]+/g)) out.add(m[0].replace(/[㐀-鿿]+$/, ''));
  for (const m of t.matchAll(/(?<![\w\\])[A-Za-z_\[][\w.\-\[\]$]*[\w\]]/g)) {
    const w = m[0];
    if (/[_.\\]/.test(w) || (/[A-Za-z]/.test(w) && /\d/.test(w))) out.add(w);
  }
  return [...out].map(x => x.replace(/^[\[(]+|[\])，。.,:;]+$/g, '')).filter(x => x.length >= 3 && !/^v?\d+(\.\d+)*$/i.test(x) && !STOP.has(x.toLowerCase()));
}
function articles(t) { // 第 6 條、第 4 點
  const out = new Set();
  for (const m of t.matchAll(/第\s*(\d{1,3})\s*(條|點|項|章|款)/g)) out.add(`第${m[1]}${m[2]}`);
  return out;
}

// 來源文字要先整理成同樣的格式，才能比對
function sourceIndex(text) {
  const t = norm(text), lower = t.toLowerCase(), compact = lower.replace(/\s+/g, '').replace(/\//g, '\\');
  const nums = new Set();
  for (const m of t.matchAll(/\d[\d,]*(?:\.\d+)?/g)) nums.add(Number(m[0].replace(/,/g, '')));
  for (const q of quantities(t)) nums.add(scaled(q));
  return { t, lower, compact, dates: dates(t), monthDays: new Set([...monthDays(t), ...[...dates(t)].map(d => d.slice(5))]), times: times(t, true), nums, articles: articles(t) };
}
function found(claim, src) {
  switch (claim.kind) {
    case 'date': return src.dates.has(claim.key);
    case 'monthday': return src.monthDays.has(claim.key);
    case 'time': return src.times.has(claim.key);
    case 'article': { // 「第 4 點」也要對得上原文的「4. 通知」「4、」「第四條」「四、」
      if (src.articles.has(claim.key)) return true;
      const n = Number(claim.key.match(/\d+/)[0]), alt = [String(n), zhNum(n)].filter(Boolean).join('|');
      return new RegExp(`第\\s*(?:${alt})\\s*[條點項章款]|(?:^|[\\n#\\s/])(?:${alt})\\s*[.、．]`).test(src.t);
    }
    case 'id': { const k = claim.key.toLowerCase().replace(/\//g, '\\').replace(/^\[|\]$/g, ''); return src.lower.includes(k) || src.compact.includes(k.replace(/\s+/g, '').replace(/[\[\]]/g, '')) || src.compact.replace(/[\[\]]/g, '').includes(k.replace(/\s+/g, '').replace(/[\[\]]/g, '')); }
    case 'qty': {
      const q = claim.q;
      if (src.nums.has(q.num) || src.nums.has(scaled(q))) return true;
      if (Number.isInteger(q.num) && q.num <= 10) return ZH_OF(q.num).some(z => new RegExp(`${z}\\s*(?:個)?\\s*${q.unit.replace(/^個/, '').replace(/[%]/g, '\\$&')}`).test(src.t));
      return false;
    }
  }
  return true;
}
function claimsOf(answer) {
  const t = claimText(answer), claims = [], seen = new Set(), add = (kind, key, shown, extra = {}) => { const k = kind + '|' + key; if (!seen.has(k)) { seen.add(k); claims.push({ kind, key, text: shown, ...extra }); } };
  const ds = dates(t); for (const d of ds) add('date', d, d);
  for (const md of monthDays(t)) if (![...ds].some(d => d.endsWith(md))) add('monthday', md, md.replace('-', '/'));
  for (const x of times(t)) add('time', x, x);
  for (const a of articles(t)) add('article', a, a);
  // 其他數量：先拿掉日期、月日、時間、條號，免得「3 月 20 日」的 3 月、20 日被當成數量
  const rest = t.replace(/(\d{4})\s*[-\/.年]\s*(\d{1,2})\s*[-\/.月]\s*(\d{1,2})\s*日?/g, ' ').replace(ROC_YMD, ' ').replace(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, ' ')
    .replace(/(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])/g, ' ').replace(/(\d{1,2})\s*點/g, ' ').replace(/第\s*\d{1,3}\s*(條|點|項|章|款)/g, ' ');
  for (const q of quantities(rest)) if (!(q.unit === '年' && q.num >= 1900)) add('qty', q.raw, q.raw, { q });
  for (const id of identifiers(t)) add('id', id, id);
  return claims;
}

// answer：模型答案；cited、visible：段落文字陣列（每段含標題、版本、日期等欄位與內文）；extra：問題、查詢日期、對話紀錄
function checkGrounding(answer, cited, visible, extra = '') {
  const citedSrc = sourceIndex([...cited, extra].join('\n')), allSrc = sourceIndex([...visible, extra].join('\n'));
  const red = [], yellow = [];
  for (const c of claimsOf(answer)) {
    if (found(c, citedSrc)) continue;
    (found(c, allSrc) ? yellow : red).push({ kind: c.kind, text: c.text });
  }
  return { red, yellow, checked: claimsOf(answer).length };
}

module.exports = { checkGrounding, claimsOf, sourceIndex };
