// usage-scan.cjs — who and what is spending the shared Claude subscription, for the DHC AI System 用量追蹤 tool.
// Reads ~/.claude/projects/**/*.jsonl incrementally (byte offset per file, state in usage-scan-state.json),
// folds every assistant call into 10-minute buckets per transcript, then writes usage-top.json with the current
// 5-hour window, the current week and today: totals, per person, per kind (對話／排程與系統), top sessions, hourly series.
// Window edges come from usage-cache.json (the seal-proxy's copy of Anthropic's /api/oauth/usage).
// Run by seal-proxy (/_usage/top) as a child process so parsing never blocks the proxy. No network, read-only on transcripts.
// Usage: node usage-scan.cjs            (update state + write usage-top.json)
//        node usage-scan.cjs --check    (also print per-window totals recomputed from scratch, for verification)
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const DIR = __dirname;
const STATE_FILE = path.join(DIR, 'usage-scan-state.json');
const OUT_FILE = path.join(DIR, 'usage-top.json');
const USAGE_FILE = path.join(DIR, 'usage-cache.json');
const WEB_DB = path.join(DIR, 'data', 'auth.db');
const BASE = 'Claude Code專案';
const KEEP_MS = 8 * 86400e3, BUCKET_MS = 10 * 60e3, H = 3600e3;
const CHECK = process.argv.includes('--check');
const { offload } = require('./offload-scan.cjs');

// Relative weight inside one model, input = 1 (Anthropic's price ratios: output 5x, cache write 5m 1.25x / 1h 2x,
// cache read 0.1x). Not converted to money and not compared across models; the model mix is shown next to it.
function weigh(u) {
  const cc = u.cache_creation || {};
  const c1h = cc.ephemeral_1h_input_tokens || 0;
  const c5m = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : Math.max(0, (u.cache_creation_input_tokens || 0) - c1h);
  return {
    w: (u.input_tokens || 0) + 5 * (u.output_tokens || 0) + 1.25 * c5m + 2 * c1h + 0.1 * (u.cache_read_input_tokens || 0),
    in: u.input_tokens || 0, out: u.output_tokens || 0, cw: c5m + c1h, cr: u.cache_read_input_tokens || 0,
  };
}

function* walk(d) {
  let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

function userText(m) {
  if (!m || m.role !== 'user') return null;
  const c = typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? (m.content.find((x) => x && x.type === 'text') || {}).text : null;
  if (!c) return null;
  const t = c.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').replace(/^﻿/, '').replace(/\s+/g, ' ').trim();
  return t && !t.startsWith('[Request interrupted') && !t.startsWith('Caveat:') ? t.slice(0, 80) : null;
}

// One transcript's new lines → its buckets. f = { size, off, sid, cwd, ep, title, first, models, b }.
// ids = every API call already counted (id → [time, output tokens counted]), across files: a forked or resumed
// session repeats earlier calls. A call written as several lines carries the streaming output count on the early lines
// and the final one on the last, so a later line with more output adds the difference.
function ingest(f, text, ids) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'ai-title' && j.aiTitle) { f.title = String(j.aiTitle).slice(0, 80); continue; }
    if (j.cwd && !f.cwd) f.cwd = j.cwd;
    if (j.entrypoint && !f.ep) f.ep = j.entrypoint;
    if (j.sessionId && !f.sid) f.sid = j.sessionId;
    if (!f.first && j.type === 'user' && !j.isMeta && !j.isSidechain) f.first = userText(j.message);
    if (!f.first && j.type === 'user' && j.isSidechain) f.firstSub = f.firstSub || userText(j.message);
    const m = j.message;
    if (j.type !== 'assistant' || !m || !m.usage || m.model === '<synthetic>') continue;
    // One API call is written as several lines (one per content block) carrying the same usage: count it once.
    const id = (m.id || '') + ':' + (j.requestId || '');
    const t = Date.parse(j.timestamp);
    const out = m.usage.output_tokens || 0;
    const prev = ids[id];
    if (prev) {
      if (out > prev[1]) {
        const b = f.b[Math.floor(prev[0] / BUCKET_MS) * BUCKET_MS] || (f.b[Math.floor(prev[0] / BUCKET_MS) * BUCKET_MS] = [0, 0, 0, 0, 0, 0, 0]);
        b[0] += 5 * (out - prev[1]); b[2] += out - prev[1];
        const model = String(m.model || '?').replace(/^claude-/, '');
        f.models[model] = (f.models[model] || 0) + 5 * (out - prev[1]);
        prev[1] = out;
      }
      continue;
    }
    if (!Number.isFinite(t)) continue;
    ids[id] = [t, out];
    const k = Math.floor(t / BUCKET_MS) * BUCKET_MS;
    const x = weigh(m.usage);
    const b = f.b[k] || (f.b[k] = [0, 0, 0, 0, 0, 0, 0]);
    b[0] += x.w; b[1] += x.in; b[2] += x.out; b[3] += x.cw; b[4] += x.cr; b[5] += 1;
    b[6] = Math.max(b[6], x.in + x.cw + x.cr); // largest context sent in this bucket
    const model = String(m.model || '?').replace(/^claude-/, '');
    f.models[model] = (f.models[model] || 0) + x.w;
  }
}

function update(state) {
  state.ids = state.ids || {};
  const now = Date.now();
  const live = new Set();
  for (const file of walk(ROOT)) {
    let st; try { st = fs.statSync(file); } catch { continue; }
    if (now - st.mtimeMs > KEEP_MS) continue;
    live.add(file);
    let f = state.files[file];
    if (!f || st.size < f.off) f = state.files[file] = { size: 0, off: 0, models: {}, b: {} };
    if (st.size === f.off) continue;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - f.off);
      fs.readSync(fd, buf, 0, buf.length, f.off);
      const end = buf.lastIndexOf(10); // only whole lines; the rest is read next time
      if (end < 0) continue;
      ingest(f, buf.subarray(0, end + 1).toString('utf8'), state.ids);
      f.off += end + 1; f.size = st.size;
    } finally { fs.closeSync(fd); }
    // Subagent transcripts live in <project>/<parent session id>/subagents/ and count toward the parent.
    const parts = file.split(path.sep), si = parts.lastIndexOf('subagents');
    if (si > 0) f.parent = parts[si - 1];
  }
  for (const [file, f] of Object.entries(state.files)) {
    if (!live.has(file)) { delete state.files[file]; continue; }
    for (const k of Object.keys(f.b)) if (now - Number(k) > KEEP_MS) delete f.b[k];
  }
  for (const [id, v] of Object.entries(state.ids)) if (now - v[0] > KEEP_MS + 86400e3) delete state.ids[id];
}

// Whose and what kind: the DHC CLI folder under Claude Code專案 is the person; sdk-ts there is a web conversation,
// anything else (sdk-cli = claude -p from a scheduled task, other folders) is 排程與系統.
function classify(f) {
  const cwd = f.cwd || '';
  const parts = cwd.split(/[\\/]/).filter(Boolean), i = parts.indexOf(BASE);
  const person = i >= 0 ? (parts[i + 1] || '(根目錄)') : '系統';
  const kind = i >= 0 && f.ep === 'sdk-ts' ? '對話' : '排程與系統';
  const where = i >= 0 ? parts.slice(i + 1).join('\\') : parts.slice(-2).join('\\');
  return { person, kind, where };
}

function windows(now) {
  let u = null; try { u = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch {}
  const edge = (bucket, len) => {
    const r = bucket && Date.parse(bucket.resets_at);
    return Number.isFinite(r) && r > now ? { start: r - len, end: r, percent: bucket.percent, from: 'oauth' } : { start: now - len, end: now, percent: null, from: 'rolling' };
  };
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  return {
    session: edge(u && u.session, 5 * H),
    week: edge(u && u.weekly_all, 7 * 86400e3),
    today: { start: day.getTime(), end: day.getTime() + 86400e3, percent: null, from: 'local' },
  };
}

// 10/28: the name people see is the web UI's (custom_name, renamed by hand or by 快速取名), not the transcript's
// ai-title. Read it fresh on every report, read-only; transcript id = provider_session_id.
function webNames() {
  const names = new Map();
  try {
    process.removeAllListeners('warning'); // node:sqlite prints an ExperimentalWarning on load
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(WEB_DB, { readOnly: true });
    for (const row of db.prepare('SELECT session_id, provider_session_id, custom_name FROM sessions WHERE custom_name IS NOT NULL').all()) {
      const name = String(row.custom_name).trim().slice(0, 80);
      if (!name) continue;
      names.set(row.provider_session_id || row.session_id, name);
      names.set(row.session_id, name);
    }
    db.close();
  } catch {}
  return names;
}

function report(state, now) {
  const names = webNames();
  const win = windows(now);
  // Fold transcripts into sessions (subagents into their parent) once.
  const sessions = new Map();
  for (const f of Object.values(state.files)) {
    const key = f.parent || f.sid;
    if (!key) continue;
    let s = sessions.get(key);
    if (!s) sessions.set(key, s = { id: key, files: [], main: null });
    s.files.push(f);
    if (!f.parent) s.main = f;
  }
  const out = { generated_at: new Date(now).toISOString(), weights: '輸入 1、輸出 5、快取寫入 1.25（5 分）／2（1 小時）、快取讀取 0.1', windows: {} };
  for (const [name, w] of Object.entries(win)) {
    const total = { w: 0, in: 0, out: 0, cw: 0, cr: 0, n: 0 };
    const people = new Map(), kinds = new Map(), rows = [];
    const series = name === 'session' ? null : new Map();
    // Buckets are 10 minutes; edges round to the nearest one (a window from 11:59:59 starts at the 12:00 bucket).
    const lo = Math.round(w.start / BUCKET_MS) * BUCKET_MS, hi = Math.round(w.end / BUCKET_MS) * BUCKET_MS;
    for (const s of sessions.values()) {
      const head = s.main || s.files[0];
      const c = classify(head);
      const r = { w: 0, n: 0, sub: 0, maxctx: 0, last: 0, models: {} };
      for (const f of s.files) {
        for (const [k, b] of Object.entries(f.b)) {
          const t = Number(k);
          if (t < lo || t >= hi) continue;
          r.w += b[0]; r.n += b[5]; if (f.parent) r.sub += b[0];
          r.maxctx = Math.max(r.maxctx, b[6]); r.last = Math.max(r.last, t + BUCKET_MS);
          total.w += b[0]; total.in += b[1]; total.out += b[2]; total.cw += b[3]; total.cr += b[4]; total.n += b[5];
          if (series) {
            const hk = Math.floor(t / H) * H, e = series.get(hk) || series.set(hk, { t: hk, 對話: 0, 排程與系統: 0 }).get(hk);
            e[c.kind] += b[0];
          }
        }
        // Model mix over the transcript's whole kept history (cheap, close enough to say "mostly Opus").
        for (const [m, v] of Object.entries(f.models)) r.models[m] = (r.models[m] || 0) + v;
      }
      if (!r.n) continue;
      const p = people.get(c.person) || people.set(c.person, { person: c.person, w: 0, n: 0, sessions: 0, 對話: 0, 排程與系統: 0 }).get(c.person);
      p.w += r.w; p.n += r.n; p.sessions += 1; p[c.kind] += r.w;
      const k = kinds.get(c.kind) || kinds.set(c.kind, { kind: c.kind, w: 0, n: 0, sessions: 0 }).get(c.kind);
      k.w += r.w; k.n += r.n; k.sessions += 1;
      const top = Object.entries(r.models).sort((a, b) => b[1] - a[1])[0];
      rows.push({
        id: s.id, title: names.get(s.id) || head.title || head.first || head.firstSub || '(沒有標題)', person: c.person, kind: c.kind, where: c.where,
        w: Math.round(r.w), n: r.n, sub_share: r.w ? +(r.sub / r.w).toFixed(3) : 0, maxctx: r.maxctx,
        last: new Date(r.last).toISOString(), model: top ? top[0] : '?',
      });
    }
    rows.sort((a, b) => b.w - a.w);
    const share = (v) => (total.w ? +(v / total.w).toFixed(4) : 0);
    out.windows[name] = {
      start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString(), percent: w.percent, edge_from: w.from,
      total: { ...total, w: Math.round(total.w), sessions: rows.length },
      by_person: [...people.values()].map((p) => ({ ...p, w: Math.round(p.w), 對話: Math.round(p.對話), 排程與系統: Math.round(p.排程與系統), share: share(p.w) })).sort((a, b) => b.w - a.w),
      by_kind: [...kinds.values()].map((k) => ({ ...k, w: Math.round(k.w), share: share(k.w) })).sort((a, b) => b.w - a.w),
      top: rows.slice(0, 30).map((r) => ({ ...r, share: share(r.w) })),
      // 10/31: other vendors over the same window (offload-scan.cjs), for the sidebar split meter.
      offload: offload(w.start, w.end),
      series: series ? [...series.values()].sort((a, b) => a.t - b.t).map((e) => ({ t: new Date(e.t).toISOString(), 對話: Math.round(e.對話), 排程與系統: Math.round(e.排程與系統) })) : undefined,
    };
    // Last hour, for "照這速度幾點用完".
    if (name === 'session') {
      let lastHour = 0;
      for (const s of sessions.values()) for (const f of s.files) for (const [k, b] of Object.entries(f.b)) if (Number(k) >= now - H) lastHour += b[0];
      out.windows.session.last_hour_w = Math.round(lastHour);
    }
  }
  return out;
}

const t0 = Date.now();
let state = { v: 3, files: {}, ids: {} };
try { const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); if (s.v === 3) state = s; } catch {}
update(state);
const out = report(state, Date.now());
out.scan_ms = Date.now() - t0;
fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state)); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
fs.writeFileSync(OUT_FILE + '.tmp', JSON.stringify(out)); fs.renameSync(OUT_FILE + '.tmp', OUT_FILE);
if (CHECK) {
  // Independent recount: full read of every kept transcript, no state, no buckets.
  const fresh = { v: 3, files: {}, ids: {} };
  update(fresh);
  const again = report(fresh, Date.now());
  for (const n of Object.keys(out.windows)) console.log(n, 'incremental', out.windows[n].total.w, out.windows[n].total.n, '| fresh', again.windows[n].total.w, again.windows[n].total.n);
}
console.log(`usage-scan: ${Object.keys(state.files).length} transcripts, ${out.scan_ms} ms`);
