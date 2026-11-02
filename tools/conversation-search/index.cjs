'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const HOME = 'C:\\Users\\demo';
const DEFAULTS = {
  db: path.join(__dirname, 'data', 'index.db'),
  projectsDir: path.join(HOME, '.claude', 'projects'),
  cardsDir: 'D:\\TAS\\Claude Code專案\\專案記憶',
  assistantDir: path.join(HOME, '.cloudcli', 'assistant', 'memory'),
  authDb: 'D:\\TAS\\cc-web\\data\\auth.db',
};
const MSG_CAP = 4000;
const CHUNK = 1200;

const normCwd = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, size INTEGER, mtime INTEGER, offset INTEGER);
CREATE TABLE IF NOT EXISTS docs(id INTEGER PRIMARY KEY, path TEXT, kind TEXT, cwd TEXT, session TEXT,
  uuid TEXT, ts INTEGER, role TEXT, text TEXT);
CREATE INDEX IF NOT EXISTS docs_path ON docs(path);
CREATE INDEX IF NOT EXISTS docs_session ON docs(session, ts);
CREATE INDEX IF NOT EXISTS docs_cwd ON docs(cwd);
CREATE TABLE IF NOT EXISTS titles(session TEXT PRIMARY KEY, title TEXT, prio INTEGER);
CREATE TABLE IF NOT EXISTS folder_cwds(folder TEXT, cwd TEXT, PRIMARY KEY(folder, cwd));
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(text, content='docs', content_rowid='id', tokenize='trigram');
CREATE VIRTUAL TABLE IF NOT EXISTS docs_vocab USING fts5vocab(docs_fts, 'row');
CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid, text) VALUES (new.id, new.text); END;
CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
`;

function openDb(file, { readOnly = false } = {}) {
  if (!readOnly) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
  if (!readOnly) {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    db.exec(SCHEMA);
  }
  return db;
}

const SKIP_PREFIX = ['<task-notification>', '<command-name>', '<command-message>', '<local-command-stdout>',
  '<local-command-caveat>', '<local-command-stderr>', 'Caveat: The messages below', '[Request interrupted',
  'Base directory for this skill', '<bash-input>', '<bash-stdout>', '<bash-stderr>'];
const COMPACT_PREFIX = 'This session is being continued from a previous conversation';

function cleanText(t) {
  return t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

// Returns {role, text} or null for a transcript line that carries human or assistant prose.
function extractMessage(o) {
  if (o.type !== 'user' && o.type !== 'assistant') return null;
  if (o.isMeta || !o.message) return null;
  const c = o.message.content;
  let text;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) text = c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  if (!text) return null;
  if (o.type === 'user' && (o.promptSource === 'system' || o.turnOrigin === 'task_notification')) return null;
  text = cleanText(text);
  if (!text) return null;
  if (SKIP_PREFIX.some((p) => text.startsWith(p))) return null;
  let role = o.type;
  if (o.isCompactSummary || text.startsWith(COMPACT_PREFIX)) role = 'compact';
  return { role, text: text.slice(0, MSG_CAP) };
}

function chunkMarkdown(text) {
  const paras = text.split(/\n(?=#{1,6} )|\n\s*\n/);
  const out = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length > CHUNK) { out.push(cur); cur = ''; }
    cur = cur ? cur + '\n\n' + p : p;
    while (cur.length > CHUNK * 2) { out.push(cur.slice(0, CHUNK)); cur = cur.slice(CHUNK); }
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function listSources(o) {
  const out = [];
  const safeDir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
  for (const proj of safeDir(o.projectsDir)) {
    if (!proj.isDirectory()) continue;
    const pdir = path.join(o.projectsDir, proj.name);
    for (const e of safeDir(pdir)) {
      const full = path.join(pdir, e.name);
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ path: full, kind: 'convo', folder: proj.name, session: e.name.slice(0, -6) });
      else if (e.isDirectory() && e.name === 'memory') {
        for (const m of safeDir(full)) if (m.isFile() && m.name.endsWith('.md')) out.push({ path: path.join(full, m.name), kind: 'memory', cwd: 'folder:' + proj.name });
      } else if (e.isDirectory()) {
        const sdir = path.join(full, 'subagents');
        for (const s of safeDir(sdir)) if (s.isFile() && s.name.endsWith('.jsonl')) out.push({ path: path.join(sdir, s.name), kind: 'subagent', folder: proj.name, session: e.name });
      }
    }
  }
  const walk = (d) => {
    for (const e of safeDir(d)) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.md')) out.push({ path: full, kind: 'card', cwd: '' });
    }
  };
  walk(o.cardsDir);
  for (const e of safeDir(o.assistantDir)) {
    if (e.isFile() && e.name.endsWith('.md')) out.push({ path: path.join(o.assistantDir, e.name), kind: 'assistant-memory', cwd: 'assistant:' + e.name.slice(0, -3) });
  }
  return out;
}

function readFrom(file, start, end) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf;
  } finally { fs.closeSync(fd); }
}

function buildIndex(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const t0 = Date.now();
  const db = openDb(o.db);
  const st = {
    getFile: db.prepare('SELECT size, mtime, offset FROM files WHERE path=?'),
    putFile: db.prepare('INSERT OR REPLACE INTO files(path,size,mtime,offset) VALUES (?,?,?,?)'),
    delDocs: db.prepare('DELETE FROM docs WHERE path=?'),
    addDoc: db.prepare('INSERT INTO docs(path,kind,cwd,session,uuid,ts,role,text) VALUES (?,?,?,?,?,?,?,?)'),
    title: db.prepare('INSERT INTO titles(session,title,prio) VALUES (?,?,?) ON CONFLICT(session) DO UPDATE SET title=excluded.title, prio=excluded.prio WHERE excluded.prio>=titles.prio'),
    folderCwd: db.prepare('INSERT OR IGNORE INTO folder_cwds(folder,cwd) VALUES (?,?)'),
    allFiles: db.prepare('SELECT path FROM files'),
    delFile: db.prepare('DELETE FROM files WHERE path=?'),
  };
  if (o.full) db.exec('DELETE FROM docs; DELETE FROM files; DELETE FROM titles; DELETE FROM folder_cwds;');
  const stats = { files: 0, changed: 0, added: 0, compact: 0, removed: 0 };
  const sources = listSources(o);
  const seen = new Set();
  for (const src of sources) {
    seen.add(src.path);
    stats.files++;
    let s;
    try { s = fs.statSync(src.path); } catch { continue; }
    const mtime = Math.floor(s.mtimeMs);
    const prev = st.getFile.get(src.path);
    if (prev && prev.size === s.size && prev.mtime === mtime) continue;
    stats.changed++;
    db.exec('BEGIN');
    try {
      if (src.kind === 'convo' || src.kind === 'subagent') {
        let start = 0;
        if (prev && s.size >= prev.size && prev.offset <= s.size) start = prev.offset;
        else st.delDocs.run(src.path);
        const buf = readFrom(src.path, start, s.size);
        const lastNl = buf.lastIndexOf(0x0a);
        const usable = lastNl < 0 ? 0 : lastNl + 1;
        const lines = buf.subarray(0, usable).toString('utf8').split('\n');
        for (const line of lines) {
          if (!line) continue;
          let r;
          try { r = JSON.parse(line); } catch { continue; }
          if (r.type === 'custom-title' && r.customTitle) { st.title.run(src.session, r.customTitle, 2); continue; }
          if (r.type === 'ai-title' && r.aiTitle) { st.title.run(src.session, r.aiTitle, 1); continue; }
          const m = extractMessage(r);
          if (!m) continue;
          const cwd = normCwd(r.cwd);
          if (cwd) st.folderCwd.run(src.folder, cwd);
          if (m.role === 'compact') stats.compact++;
          const ts = Date.parse(r.timestamp) || mtime;
          st.addDoc.run(src.path, src.kind, cwd, src.session, r.uuid || null, ts, m.role, m.text);
          stats.added++;
        }
        st.putFile.run(src.path, s.size, mtime, start + usable);
      } else {
        st.delDocs.run(src.path);
        const text = fs.readFileSync(src.path, 'utf8');
        const key = src.kind === 'card' ? 'card:' + path.relative(o.cardsDir, src.path) : src.kind + ':' + src.path;
        for (const chunk of chunkMarkdown(text)) {
          st.addDoc.run(src.path, src.kind, src.cwd, key, null, mtime, 'doc', chunk);
          stats.added++;
        }
        st.putFile.run(src.path, s.size, mtime, s.size);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  db.exec('BEGIN');
  for (const { path: p } of st.allFiles.all()) {
    if (!seen.has(p)) { st.delDocs.run(p); st.delFile.run(p); stats.removed++; }
  }
  db.exec('COMMIT');
  if (stats.changed && o.authDb && fs.existsSync(o.authDb)) {
    try {
      const a = new DatabaseSync(o.authDb, { readOnly: true });
      const rows = a.prepare("SELECT session_id, custom_name FROM sessions WHERE custom_name IS NOT NULL AND custom_name<>''").all();
      a.close();
      db.exec('BEGIN');
      for (const r of rows) st.title.run(r.session_id, r.custom_name, 3);
      db.exec('COMMIT');
    } catch { /* auth.db busy or schema changed: titles fall back to jsonl titles */ }
  }
  if (o.full || stats.added > 20000) db.exec("INSERT INTO docs_fts(docs_fts) VALUES('optimize')");
  db.close();
  stats.ms = Date.now() - t0;
  return stats;
}

module.exports = { buildIndex, openDb, normCwd, extractMessage, chunkMarkdown, DEFAULTS };

if (require.main === module) {
  const full = process.argv.includes('--full');
  const stats = buildIndex({ full });
  let size = 0;
  try { size = fs.statSync(DEFAULTS.db).size; } catch {}
  console.log(JSON.stringify({ ...stats, dbMB: +(size / 1048576).toFixed(1) }));
}
