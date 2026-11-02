'use strict';
const { openDb, normCwd, DEFAULTS } = require('./index.cjs');

const KIND_SQL = {
  convo: "d.kind IN ('convo','subagent')",
  memory: "d.kind='memory'",
  card: "d.kind='card'",
  'assistant-memory': "d.kind='assistant-memory'",
};
const KIND_WEIGHT = { convo: 1, subagent: 0.5, memory: 1.2, card: 1.2, 'assistant-memory': 1.2 };
const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]+/g;
const STOP = new Set(['the', 'and', 'for', 'you', 'this', 'that', 'with', 'are', 'can', 'not', 'but', 'have', 'from', 'what', 'how', 'was', 'please']);

const ftsPhrase = (t) => '"' + t.replace(/"/g, '""') + '"';
const likeEsc = (t) => '%' + t.replace(/[\\%_]/g, (c) => '\\' + c) + '%';

function recencyMult(ts, now) {
  const ageDays = Math.max(0, (now - ts) / 86400000);
  return 1 + Math.exp(-ageDays / 30);
}

function scopeClause(db, cwd, params) {
  if (!cwd) return '';
  const c = normCwd(cwd);
  const folders = db.prepare('SELECT folder FROM folder_cwds WHERE cwd=?').all(c).map((r) => 'folder:' + r.folder);
  params.push(c, ...folders);
  return ` AND (d.cwd=? OR d.kind='card'${folders.length ? ` OR d.cwd IN (${folders.map(() => '?').join(',')})` : ''})`;
}

function filters(db, o, params) {
  let sql = '';
  if (o.kinds) sql += ' AND (' + o.kinds.map((k) => KIND_SQL[k]).join(' OR ') + ')';
  if (!o.includeCompact) sql += " AND d.role<>'compact'";
  if (o.excludeSession) { sql += ' AND d.session<>?'; params.push(o.excludeSession); }
  sql += scopeClause(db, o.cwd, params);
  return sql;
}

// Exact mode: whitespace-separated terms, all required. >=3 chars via FTS trigram, shorter via LIKE.
function candidatesExact(db, o) {
  const terms = o.query.trim().split(/\s+/).filter(Boolean);
  const fts = terms.filter((t) => [...t].length >= 3);
  const like = terms.filter((t) => [...t].length < 3);
  const params = [];
  let sql;
  if (fts.length) {
    params.push(fts.map(ftsPhrase).join(' AND '));
    sql = 'SELECT d.id,d.kind,d.cwd,d.session,d.ts,d.role,d.text,bm25(docs_fts) AS r FROM docs_fts JOIN docs d ON d.id=docs_fts.rowid WHERE docs_fts MATCH ?';
  } else {
    sql = 'SELECT d.id,d.kind,d.cwd,d.session,d.ts,d.role,d.text,0 AS r FROM docs d WHERE 1';
  }
  for (const t of like) { sql += " AND d.text LIKE ? ESCAPE '\\'"; params.push(likeEsc(t)); }
  sql += filters(db, o, params);
  sql += fts.length ? ' ORDER BY r LIMIT 400' : ' ORDER BY d.ts DESC LIMIT 400';
  const rows = db.prepare(sql).all(...params);
  return { rows, terms };
}

// Fuzzy mode (for prompts): split the prompt into content words at filler words, then
// retrieve by trigrams (words >=3 chars) and LIKE (2-char words); score by word coverage.
const FILLER = ['是不是', '有沒有', '為什麼', '可不可以', '幫我', '請你', '一下', '怎麼', '如何', '是否', '可以', '好像',
  '今天', '現在', '我們', '你們', '什麼', '這個', '那個', '看看', '一個', '還是', '然後', '因為', '所以', '已經', '多少', '一些', '一點', '東西',
  '的', '了', '嗎', '呢', '吧', '啊', '把', '和', '跟', '與', '你', '我', '他', '也', '都', '還', '就', '再', '又', '要', '請', '是', '在', '有', '沒'];
const FILLER_RE = new RegExp(FILLER.join('|'), 'g');

function promptUnits(db, prompt, maxUnits = 12) {
  const cand = new Map();
  let seg = 0;
  for (const m of prompt.matchAll(/[A-Za-z][A-Za-z0-9_.+-]+/g)) {
    const w = m[0].toLowerCase().replace(/[.+-]+$/, '');
    if (w.length >= 2 && !STOP.has(w) && !cand.has(w)) cand.set(w, seg++);
  }
  for (const m of prompt.matchAll(CJK_RUN)) {
    for (const part of m[0].split(FILLER_RE)) {
      const cs = [...part];
      if (cs.length === 2 || cs.length === 3) { if (!cand.has(part)) cand.set(part, seg); }
      else if (cs.length >= 4) for (let i = 0; i + 2 <= cs.length; i++) if (!cand.has(cs[i] + cs[i + 1])) cand.set(cs[i] + cs[i + 1], seg);
      seg++;
    }
  }
  if (!cand.size) return [];
  const total = db.prepare('SELECT count(*) AS n FROM docs').get().n;
  const maxDf = Math.max(30, Math.floor(total * 0.03));
  const exact = db.prepare('SELECT doc FROM docs_vocab WHERE term=?');
  const prefix = db.prepare('SELECT coalesce(sum(doc),0) AS d FROM docs_vocab WHERE term>=? AND term<?');
  const out = [];
  for (const [w, sid] of cand) {
    const cs = [...w];
    let df;
    if (cs.length >= 3) {
      const grams = [];
      for (let i = 0; i + 3 <= cs.length; i++) grams.push(cs.slice(i, i + 3).join(''));
      df = Math.min(...grams.map((g) => (exact.get(g) || { doc: 0 }).doc));
    } else {
      df = Math.min(total, prefix.get(w, w + '\u{10ffff}').d);
    }
    if (df === 0 || df > maxDf) continue;
    out.push({ w, sid, df, fts: cs.length >= 3, idf: Math.log(total / df) });
  }
  out.sort((a, b) => a.df - b.df);
  return out.slice(0, maxUnits);
}

function candidatesFuzzy(db, o) {
  const units = promptUnits(db, o.query);
  const terms = units.map((x) => x.w);
  if (units.length < 2) return { rows: [], terms };
  const byId = new Map();
  const ftsUnits = units.filter((x) => x.fts);
  if (ftsUnits.length) {
    const params = [ftsUnits.map((x) => ftsPhrase(x.w)).join(' OR ')];
    const sql = 'SELECT d.id,d.kind,d.cwd,d.session,d.ts,d.role,d.text,bm25(docs_fts) AS r FROM docs_fts JOIN docs d ON d.id=docs_fts.rowid WHERE docs_fts MATCH ?'
      + filters(db, o, params) + ' ORDER BY r LIMIT 100';
    for (const r of db.prepare(sql).all(...params)) byId.set(r.id, r);
  }
  const short = units.filter((x) => !x.fts);
  if (short.length) {
    const params = short.map((x) => likeEsc(x.w));
    const sql = 'SELECT d.id,d.kind,d.cwd,d.session,d.ts,d.role,d.text,0 AS r FROM docs d WHERE ('
      + short.map(() => "d.text LIKE ? ESCAPE '\\'").join(' OR ') + ')' + filters(db, o, params) + ' ORDER BY d.ts DESC LIMIT 400';
    for (const r of db.prepare(sql).all(...params)) if (!byId.has(r.id)) byId.set(r.id, r);
  }
  const wsum = units.reduce((s, x) => s + x.idf, 0);
  const rows = [...byId.values()];
  for (const row of rows) {
    const low = row.text.toLowerCase();
    const hit = units.filter((x) => low.includes(x.w));
    row.matched = hit.length;
    row.segs = new Set(hit.map((x) => x.sid)).size;
    row.coverage = hit.reduce((s, x) => s + x.idf, 0) / wsum;
  }
  return { rows, terms };
}

function snippet(text, terms, width = 70) {
  const low = text.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const i = low.indexOf(t.toLowerCase());
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  if (pos < 0) pos = 0;
  const start = Math.max(0, pos - Math.floor(width / 3));
  let s = text.slice(start, start + width).replace(/\s+/g, ' ');
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  if (sorted.length) {
    const re = new RegExp('(' + sorted.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
    s = s.replace(re, '【$1】');
  }
  return (start > 0 ? '…' : '') + s + (start + width < text.length ? '…' : '');
}

function search(o) {
  const t0 = process.hrtime.bigint();
  const own = !o.db || typeof o.db === 'string';
  const db = own ? openDb(o.db || DEFAULTS.db, { readOnly: true }) : o.db;
  try {
    const opts = { limit: 5, ...o };
    if (opts.kind) opts.kinds = [opts.kind];
    const { rows, terms } = opts.fuzzy ? candidatesFuzzy(db, opts) : candidatesExact(db, opts);
    const now = opts.now || Date.now();
    const titleQ = db.prepare('SELECT title FROM titles WHERE session=?');
    const groups = new Map();
    for (const r of rows) {
      const base = opts.fuzzy ? r.coverage * 10 + -r.r * 0.1 : (r.r ? -r.r : 1);
      r.score = base * recencyMult(r.ts, now) * (KIND_WEIGHT[r.kind] || 1);
      const key = r.session || 'doc:' + r.id;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { session: r.session, kind: r.kind, cwd: r.cwd, ts: r.ts, score: 0, hits: [], seen: new Set() }));
      const sig = r.text.slice(0, 80);
      if (g.seen.has(sig)) continue;
      g.seen.add(sig);
      g.hits.push(r);
      g.score = Math.max(g.score, r.score);
      g.ts = Math.max(g.ts, r.ts);
      if (r.kind === 'convo') g.kind = 'convo';
    }
    const out = [...groups.values()].sort((a, b) => b.score - a.score).slice(0, opts.limit).map((g) => {
      g.hits.sort((a, b) => b.score - a.score);
      const t = g.session && titleQ.get(g.session);
      return {
        session: g.session, kind: g.kind, cwd: g.cwd, date: new Date(g.ts).toISOString().slice(0, 10),
        title: t ? t.title : null, score: +g.score.toFixed(3),
        hits: g.hits.slice(0, 2).map((h) => ({ id: h.id, role: h.role, snippet: snippet(h.text, terms), coverage: h.coverage, matched: h.matched, segs: h.segs })),
      };
    });
    return { results: out, terms, candidates: rows.length, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  } finally { if (own) db.close(); }
}

function scroll(o) {
  const db = openDb(o.db || DEFAULTS.db, { readOnly: true });
  try {
    const rows = db.prepare("SELECT id,uuid,role,ts,text FROM docs WHERE session=? AND role<>'compact' ORDER BY ts,id").all(o.session);
    let i = rows.findIndex((r) => String(r.id) === String(o.around) || r.uuid === o.around);
    if (i < 0) i = 0;
    const span = o.span || 3;
    return rows.slice(Math.max(0, i - span), i + span + 1).map((r) => ({ id: r.id, role: r.role, ts: new Date(r.ts).toISOString().slice(0, 16), here: r === rows[i], text: r.text.slice(0, 300) }));
  } finally { db.close(); }
}

const shortCwd = (c) => (c || '').replace(/^d:\\tas\\claude code專案\\/, '').replace(/^folder:/, '');

function format(res, cap = 1500) {
  if (!res.results.length) return `（沒有結果，${res.ms.toFixed(0)} ms）`;
  const lines = [];
  res.results.forEach((g, n) => {
    const label = g.kind === 'convo' || g.kind === 'subagent' ? `${g.title || ''} ｜${shortCwd(g.cwd)}｜${g.session}` : String(g.session).split(/[\\/]/).pop();
    lines.push(`[${n + 1}] ${g.date} ${g.kind} ${label}`);
    for (const h of g.hits) lines.push(`    #${h.id} ${h.role}: ${h.snippet}`);
  });
  lines.push(`（${res.results.length} 組，候選 ${res.candidates}，${res.ms.toFixed(0)} ms）`);
  let s = lines.join('\n');
  if (s.length > cap) s = s.slice(0, cap - 1) + '…';
  return s;
}

module.exports = { search, scroll, format, promptUnits, snippet };

if (require.main === module) {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const json = a.includes('--json');
  const session = opt('--session');
  if (session) {
    const rows = scroll({ session, around: opt('--around') });
    if (json) console.log(JSON.stringify(rows));
    else for (const r of rows) console.log(`${r.here ? '>' : ' '} #${r.id} ${r.ts} ${r.role}: ${r.text.replace(/\s+/g, ' ')}`);
    process.exit(0);
  }
  const flagsWithVal = new Set(['--cwd', '--kind', '--limit', '--session', '--around']);
  const query = a.filter((x, i) => !x.startsWith('--') && !flagsWithVal.has(a[i - 1])).join(' ');
  if (!query) { console.error('用法: node search.cjs "<query>" [--cwd <path>] [--kind convo|memory|card|assistant-memory] [--limit 5] [--session <id> --around <msgId>] [--json]'); process.exit(2); }
  const res = search({ query, cwd: opt('--cwd'), kind: opt('--kind'), limit: +(opt('--limit') || 5), fuzzy: a.includes('--fuzzy') });
  console.log(json ? JSON.stringify(res) : format(res));
}
